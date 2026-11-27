"""Speech to text for the MFF AI module: faster-whisper (large-v3-turbo, int8_float16)
on the AI GPU next to the main model. POST /transcribe with the audio as the body
(any format PyAV reads: webm/opus from browsers, wav, mp3, m4a, ...).
Query: language (optional, e.g. en), prompt (optional words to expect).
Returns {text, language, duration, seconds}. One request at a time."""
import os, tempfile, threading, time
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.concurrency import run_in_threadpool
from faster_whisper import WhisperModel

MODEL = os.environ.get('WHISPER_MODEL', '/home/ai/models/whisper/large-v3-turbo')
MAX_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 600
VOCABULARY = ('MFF, cryo-EM, Krios, Glacios, apoferritin, lysozyme, HEPES, Tris, crystallography, crystallisation, '
              'beamline, Diamond, synchrotron, Coot, ChimeraX, CCP4, Phenix, RELION, cryoSPARC, Slurm, PDB, mmCIF, MTZ.')
model = WhisperModel(MODEL, device='cuda', compute_type='int8_float16')
lock = threading.Lock()

class TooLong(Exception):
    pass

def work(path, language, prompt):
    with lock:
        t = time.time()
        segments, info = model.transcribe(path, beam_size=5, vad_filter=True, language=language or None,
                                          initial_prompt=(prompt or VOCABULARY)[:800])
        if info.duration > MAX_SECONDS:
            raise TooLong('the recording is longer than 10 minutes')
        text = ' '.join(s.text.strip() for s in segments).strip()
        return {'text': text, 'language': info.language, 'duration': round(info.duration, 1), 'seconds': round(time.time() - t, 2)}

async def transcribe(request):
    body = await request.body()
    if not body:
        return JSONResponse({'error': 'no audio'}, status_code=400)
    if len(body) > MAX_BYTES:
        return JSONResponse({'error': 'the recording is too large (25 MB at most)'}, status_code=413)
    language = request.query_params.get('language', '')[:5]
    prompt = request.query_params.get('prompt', '')
    with tempfile.NamedTemporaryFile(suffix='.audio', dir=os.environ.get('TMPDIR', '/tmp')) as f:
        f.write(body)
        f.flush()
        try:
            return JSONResponse(await run_in_threadpool(work, f.name, language, prompt))
        except TooLong as e:
            return JSONResponse({'error': str(e)}, status_code=413)
        except Exception as e:
            return JSONResponse({'error': 'the recording could not be read'}, status_code=422)

async def health(request):
    return JSONResponse({'ok': True, 'model': os.path.basename(MODEL)})

app = Starlette(routes=[Route('/transcribe', transcribe, methods=['POST']), Route('/health', health)])
