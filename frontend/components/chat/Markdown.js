// Renders an answer: Markdown with tables, code with a Copy button, and maths.
// Raw HTML is never rendered, and images are shown as links instead of being
// loaded: an answer must not be able to make the browser contact another site.
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import copyText from './copyText';
import css from './chat.module.css';

const REMARK = [remarkGfm, remarkMath];
const REHYPE = [[rehypeKatex, { strict: 'ignore', throwOnError: false }], rehypeHighlight];

// Models also write maths as \( \) and \[ \]. Convert them, but not in code.
function normaliseMaths(text) {
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, i) => (i % 2 ? part : part
    .replace(/\\\[([\s\S]*?)\\\]/g, (m, x) => `\n$$\n${x.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (m, x) => `$${x.trim()}$`))).join('');
}

function CodeBlock({ children }) {
  const ref = React.useRef(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(ref.current ? ref.current.innerText : '')) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className={css.codeBlock}>
      <button type="button" className={css.codeCopy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const COMPONENTS = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
  img: ({ src, alt }) => <a href={src} target="_blank" rel="noopener noreferrer nofollow">[image: {alt || src}]</a>,
  table: ({ children }) => <div className={css.tableWrap}><table>{children}</table></div>
};

function Markdown({ text }) {
  return (
    <div className={css.markdown}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
        {normaliseMaths(text)}
      </ReactMarkdown>
    </div>
  );
}

export default React.memo(Markdown);
