// vllm_controller.cpp
//
// Manages a single vLLM `vllm serve` subprocess on gpu6's dedicated AI GPU (nvidia-smi index 3).
// Listens on a Unix domain socket for commands to switch which model is
// loaded. Only one model runs at a time; switching stops the current
// vllm process and starts a new one.
//
// Commands (newline-terminated, sent over the socket):
//   SWITCH <keyword>   - stop current model, start the named one.
//                         Streams progress lines back over the same
//                         connection as the switch happens, then closes
//                         once the new model is confirmed ready. Waits
//                         as long as it takes -- no arbitrary timeout,
//                         no automatic force-kill. Only exits early if
//                         the process dies on its own.
//   STATUS             - report which model is currently loaded.
//   FORCEKILL          - immediately SIGKILL whatever is currently
//                         running. Only ever invoked explicitly by you;
//                         the daemon never decides on its own that a
//                         graceful shutdown has taken "too long".
//
// Keywords: mistral, qwen, deepseek, and Qwen's precision variants
// qwen-fp8kv (bf16 weights, FP8 KV cache) and qwen-fp8 (FP8 weights, FP8 KV
// cache). Every Qwen variant is served as "qwen". Each keyword has its own
// --max-model-len; all Qwen modes fit the trained 262,144 tokens (measured on
// GPU 3 on 26/11/2026: KV cache 504k / 995k / 1,715k tokens).
//
// Each connection is handled on its own thread, so a STATUS query (or a
// second SWITCH) doesn't block behind an in-progress switch.
//
// Build: g++ -std=c++17 -O2 -pthread -o vllm_controller vllm_controller.cpp

#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

namespace {

constexpr const char* kSocketPath = "/home/ai/vllm-controller.sock";
constexpr const char* kVllmBinary = "/home/ai/micromamba/envs/vllm/bin/vllm";
constexpr const char* kDefaultModel = "qwen";
constexpr int kPort = 8000;

struct ModelSpec {
  std::string path;
  int max_model_len;
  std::vector<std::string> extra_args;
};

const std::map<std::string, ModelSpec>& model_table() {
  static const std::map<std::string, ModelSpec> table = {
      {"mistral",
       {"/home/ai/models/llm/Mistral-Small-3.2-24B", 32768,
        {"--served-model-name", "mistral",
         "--tokenizer-mode", "mistral", "--config-format", "mistral",
         "--load-format", "mistral"}}},
      {"qwen",
       {"/home/ai/models/llm/Qwen3.6-27B", 262144,
        {"--served-model-name", "qwen", "--max-num-seqs", "512",
         "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_coder",
         "--reasoning-parser", "qwen3"}}},
      {"qwen-fp8kv",
       {"/home/ai/models/llm/Qwen3.6-27B", 262144,
        {"--served-model-name", "qwen", "--max-num-seqs", "512",
         "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_coder",
         "--reasoning-parser", "qwen3", "--kv-cache-dtype", "fp8",
         // FlashInfer cannot build its FP8-KV kernels in this env (nvcc 13.3
         // vs CUDA 13.0 headers); Triton attention can.
         "--attention-backend", "TRITON_ATTN"}}},
      {"qwen-fp8",
       {"/home/ai/models/llm/Qwen3.6-27B-FP8", 262144,
        {"--served-model-name", "qwen", "--max-num-seqs", "512",
         "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_coder",
         "--reasoning-parser", "qwen3", "--kv-cache-dtype", "fp8",
         // FlashInfer cannot build its FP8-KV kernels in this env (nvcc 13.3
         // vs CUDA 13.0 headers); Triton attention can.
         "--attention-backend", "TRITON_ATTN"}}},
      {"deepseek",
       {"/home/ai/models/llm/DeepSeek-R1-Distill-Qwen-32B", 32768,
        {"--served-model-name", "deepseek", "--reasoning-parser", "deepseek_r1"}}},
  };
  return table;
}

// g_name_mutex guards ONLY g_current_model, and is held only for the
// brief moments it's actually read or written -- never across the long
// stop/launch/wait-for-ready operations. STATUS therefore never blocks
// behind an in-progress SWITCH.
std::mutex g_name_mutex;
std::string g_current_model;
std::atomic<pid_t> g_child_pid{-1};
std::atomic<bool> g_switch_in_progress{false};

std::string get_current_model() {
  std::lock_guard<std::mutex> lock(g_name_mutex);
  return g_current_model;
}

void set_current_model(const std::string& name) {
  std::lock_guard<std::mutex> lock(g_name_mutex);
  g_current_model = name;
}

std::string log_path_for(const std::string& keyword) {
  return "/home/ai/logs/vllm-" + keyword + ".log";
}

std::vector<std::string> build_args(const ModelSpec& spec) {
  std::vector<std::string> args = {
      kVllmBinary,   "serve",
      spec.path,     "--max-model-len",
      std::to_string(spec.max_model_len), "--gpu-memory-utilization",
      "0.9",         "--port",
      std::to_string(kPort)};
  for (const auto& a : spec.extra_args) args.push_back(a);
  return args;
}

pid_t launch_model(const std::string& keyword) {
  const auto& table = model_table();
  auto it = table.find(keyword);
  if (it == table.end()) return -1;

  std::vector<std::string> args = build_args(it->second);
  std::vector<char*> argv;
  argv.reserve(args.size() + 1);
  for (auto& a : args) argv.push_back(a.data());
  argv.push_back(nullptr);

  // Truncate the log file HERE, in the parent, before forking. This is
  // synchronous and guaranteed to complete before wait_until_ready()
  // (also called from the parent, after fork() returns) ever reads the
  // file -- so it can never observe a stale "ready" marker from a
  // previous run. Truncating inside the child after fork() would race
  // against the parent's first read with no ordering guarantee.
  std::string log_path = log_path_for(keyword);
  {
    std::ofstream truncate(log_path, std::ios::trunc);
  }

  pid_t pid = fork();
  if (pid == 0) {
    // Become our own process group leader. vLLM spawns several
    // subprocesses (the API server, the EngineCore worker, a
    // multiprocessing resource tracker); they all inherit this PGID.
    // Signaling the whole group (kill(-pid, ...)) on stop reaches all
    // of them at once, instead of relying on the API server process to
    // correctly cascade shutdown to its own children.
    setpgid(0, 0);

    FILE* log = std::freopen(log_path.c_str(), "a", stdout);
    if (log) dup2(fileno(stdout), STDERR_FILENO);

    execv(kVllmBinary, argv.data());
    std::perror("execv failed");
    _exit(127);
  }
  return pid;
}

// Returns true if the process is still alive. With SIGCHLD set to
// SIG_IGN (see main()), the kernel reaps exited children automatically,
// so waitpid() here would race against that and is unreliable -- a
// simple kill(pid, 0) existence check is race-free instead.
bool process_alive(pid_t pid) {
  return kill(pid, 0) == 0;
}

template <typename ProgressFn>
void stop_current_model(ProgressFn progress) {
  pid_t pid = g_child_pid.load();
  if (pid <= 0) {
    progress("no model currently running\n");
    return;
  }

  progress("stopping pid " + std::to_string(pid) + "...\n");
  kill(-pid, SIGTERM);
  int elapsed = 0;
  while (process_alive(pid)) {
    if (elapsed > 0 && elapsed % 2 == 0) {
      progress("  still stopping (" + std::to_string(elapsed) + "s)...\n");
    }
    std::this_thread::sleep_for(std::chrono::seconds(1));
    ++elapsed;
  }
  g_child_pid.store(-1);
  progress("stopped (" + std::to_string(elapsed) + "s)\n");
}

// Force-kills the current model immediately, no grace period. Only
// invoked by an explicit FORCEKILL command -- never automatically.
template <typename ProgressFn>
void force_kill_current_model(ProgressFn progress) {
  pid_t pid = g_child_pid.load();
  if (pid <= 0) {
    progress("no model currently running\n");
    return;
  }
  progress("sending SIGKILL to pid " + std::to_string(pid) + "...\n");
  kill(-pid, SIGKILL);
  int elapsed = 0;
  while (process_alive(pid)) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    if (++elapsed > 25) break;  // ~5s sanity bound just to return control
  }
  g_child_pid.store(-1);
  progress("killed\n");
}

template <typename ProgressFn>
bool wait_until_ready(const std::string& keyword, pid_t pid,
                       ProgressFn progress) {
  std::string path = log_path_for(keyword);
  int elapsed = 0;
  while (true) {
    if (!process_alive(pid)) {
      progress("process exited before becoming ready (see " + path +
                ")\n");
      return false;
    }

    std::ifstream in(path);
    if (in) {
      std::string line;
      while (std::getline(in, line)) {
        if (line.find("Application startup complete") != std::string::npos) {
          progress("ready (" + std::to_string(elapsed) + "s)\n");
          return true;
        }
      }
    }
    if (elapsed > 0 && elapsed % 2 == 0) {
      progress("  still loading (" + std::to_string(elapsed) + "s)...\n");
    }
    std::this_thread::sleep_for(std::chrono::seconds(1));
    ++elapsed;
  }
}

template <typename ProgressFn>
void handle_switch(const std::string& keyword, ProgressFn progress) {
  if (model_table().find(keyword) == model_table().end()) {
    std::string valid;
    for (const auto& kv : model_table()) valid += (valid.empty() ? "" : ", ") + kv.first;
    progress("ERROR unknown model '" + keyword + "' (valid: " + valid + ")\n");
    return;
  }

  // This is the ONLY thing serializing switches -- no mutex is held
  // across the long operation below, so STATUS (and a rejected second
  // SWITCH) can still be answered immediately by any other thread.
  bool expected = false;
  if (!g_switch_in_progress.compare_exchange_strong(expected, true)) {
    progress("ERROR a switch is already in progress\n");
    return;
  }

  if (get_current_model() == keyword && g_child_pid.load() > 0) {
    progress("OK already running " + keyword + "\n");
    g_switch_in_progress.store(false);
    return;
  }

  if (g_child_pid.load() > 0) {
    progress("stopping current model '" + get_current_model() + "'...\n");
    stop_current_model(progress);
  }

  progress("launching " + keyword + "...\n");
  pid_t pid = launch_model(keyword);
  if (pid <= 0) {
    progress("ERROR failed to launch " + keyword + "\n");
    g_switch_in_progress.store(false);
    return;
  }
  g_child_pid.store(pid);
  set_current_model(keyword);
  progress("launched pid " + std::to_string(pid) +
            ", waiting for it to become ready...\n");

  bool ok = wait_until_ready(keyword, pid, progress);
  progress(ok ? ("OK " + keyword + " is ready on port " +
                  std::to_string(kPort) + "\n")
              : ("ERROR " + keyword + " did not become ready in time\n"));
  g_switch_in_progress.store(false);
}

std::string handle_status() {
  std::ostringstream oss;
  pid_t pid = g_child_pid.load();
  if (pid > 0) {
    oss << "RUNNING " << get_current_model() << " (pid " << pid << ")";
    if (g_switch_in_progress.load()) oss << " [switch in progress]";
    oss << "\n";
  } else {
    if (g_switch_in_progress.load()) {
      oss << "STOPPED [switch in progress]\n";
    } else {
      oss << "STOPPED\n";
    }
  }
  return oss.str();
}

std::atomic<int> g_server_fd{-1};

void on_sigterm(int) {
  pid_t pid = g_child_pid.load();
  if (pid > 0) {
    kill(-pid, SIGTERM);
    // Best-effort brief wait; SIGCHLD is SIG_IGN so the kernel reaps it
    // regardless once it exits. We're exiting either way.
    for (int i = 0; i < 5 && kill(pid, 0) == 0; ++i) {
      struct timespec ts{0, 200000000};
      nanosleep(&ts, nullptr);
    }
  }
  unlink(kSocketPath);
  _exit(0);
}

void write_line(int fd, const std::string& line) {
  ssize_t written = write(fd, line.data(), line.size());
  (void)written;
}

void handle_connection(int client_fd) {
  std::array<char, 256> buf{};
  ssize_t n = read(client_fd, buf.data(), buf.size() - 1);
  if (n > 0) {
    buf[n] = '\0';
    std::string line(buf.data());
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) {
      line.pop_back();
    }

    std::istringstream iss(line);
    std::string cmd;
    iss >> cmd;
    if (cmd == "SWITCH") {
      std::string keyword;
      iss >> keyword;
      handle_switch(keyword,
                     [&](const std::string& msg) { write_line(client_fd, msg); });
    } else if (cmd == "STATUS") {
      write_line(client_fd, handle_status());
    } else if (cmd == "FORCEKILL") {
      // Deliberately bypasses g_switch_in_progress -- this is for
      // manual intervention if you decide (not the daemon) that
      // graceful shutdown has taken too long. Never invoked
      // automatically.
      force_kill_current_model(
          [&](const std::string& msg) { write_line(client_fd, msg); });
    } else {
      write_line(client_fd, "ERROR unknown command '" + cmd + "'\n");
    }
  }
  close(client_fd);
}

int run_server() {
  unlink(kSocketPath);

  int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server_fd < 0) {
    std::perror("socket");
    return 1;
  }
  g_server_fd.store(server_fd);

  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::strncpy(addr.sun_path, kSocketPath, sizeof(addr.sun_path) - 1);

  if (bind(server_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
    std::perror("bind");
    return 1;
  }
  chmod(kSocketPath, 0666);

  if (listen(server_fd, 8) < 0) {
    std::perror("listen");
    return 1;
  }
  fcntl(server_fd, F_SETFD, FD_CLOEXEC);

  std::cout << "vllm_controller listening on " << kSocketPath << std::endl;

  pid_t pid = launch_model(kDefaultModel);
  if (pid > 0) {
    g_child_pid.store(pid);
    g_current_model = kDefaultModel;
    std::cout << "Launched default model '" << kDefaultModel << "' (pid "
              << pid << ")" << std::endl;
  } else {
    std::cerr << "Failed to launch default model" << std::endl;
  }

  while (true) {
    int client_fd = accept(server_fd, nullptr, nullptr);
    if (client_fd < 0) {
      if (errno == EINTR) continue;
      std::perror("accept");
      continue;
    }
    // Without this, fork() (in launch_model) duplicates this fd into
    // the vllm child process, which never closes it. The child then
    // holds the connection open for its entire lifetime, and the real
    // client never sees EOF even after we close our own copy -- it
    // just hangs indefinitely. FD_CLOEXEC makes execv() close it
    // automatically in the child.
    fcntl(client_fd, F_SETFD, FD_CLOEXEC);
    std::thread(handle_connection, client_fd).detach();
  }

  close(server_fd);
  return 0;
}

}  // namespace

int main() {
  // SIG_IGN for SIGCHLD makes the kernel auto-reap exited children
  // (POSIX.1-2001 behavior on Linux), so no zombies accumulate and no
  // manual waitpid() is needed anywhere -- liveness is checked instead
  // via kill(pid, 0) in process_alive(), which doesn't race against an
  // asynchronous reaper.
  signal(SIGCHLD, SIG_IGN);
  signal(SIGTERM, on_sigterm);
  signal(SIGINT, on_sigterm);
  return run_server();
}
