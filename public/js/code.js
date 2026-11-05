// Renders a code snippet into a <code> element as numbered lines with light syntax colouring.
// Built with DOM nodes only (no innerHTML). The element's textContent stays exactly the snippet,
// so copying textContent copies the real code.

const TOKEN = /("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|((?:^|\s)#.*$)|(--?[A-Za-z][\w-]*)|\b(true|false|null)\b/g;

function lineNodes(line) {
  const out = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > last) out.push(document.createTextNode(line.slice(last, m.index)));
    const span = document.createElement("span");
    span.className = m[1] ? "tok-s" : m[2] ? "tok-c" : "tok-k";
    span.textContent = m[0];
    out.push(span);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(document.createTextNode(line.slice(last)));
  return out;
}

export function renderCode(codeEl, text, { numbered = true } = {}) {
  const lines = text.split("\n");
  const nodes = [];
  lines.forEach((line, i) => {
    const end = i < lines.length - 1 ? "\n" : "";
    if (numbered) {
      // the newline lives inside the block line so it adds no blank line but stays in textContent
      const ln = document.createElement("span");
      ln.className = "ln";
      ln.append(...lineNodes(line), end);
      nodes.push(ln);
    } else nodes.push(...lineNodes(line), end);
  });
  codeEl.replaceChildren(...nodes);
}
