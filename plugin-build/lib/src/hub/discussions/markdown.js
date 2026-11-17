import { marked } from 'marked';
import { decodeHTMLStrict } from 'entities';
const cache = new WeakMap();
/** Tokenize once per immutable message. Only a small DOM vocabulary crosses
 * the API; raw HTML is literal text and external images are explicit links. */
export function groupMarkdown(message) {
    const existing = cache.get(message);
    if (existing)
        return existing;
    let budget = 4000;
    const text = (value) => ({ text: value });
    const element = (tag, children) => ({ tag, children });
    const tokens = (items, depth = 0) => items.flatMap(token => {
        if (--budget < 0 || depth > 24)
            throw Error('markdown bound');
        const children = (items) => tokens(items ?? [], depth + 1);
        switch (token.type) {
            case 'space':
            case 'def': return [];
            case 'heading': return [element('h' + Math.max(1, Math.min(6, token.depth)), children(token.tokens))];
            case 'paragraph': return [element('p', children(token.tokens))];
            case 'text': return token.tokens ? children(token.tokens) : [text(decodeHTMLStrict(token.text))];
            case 'escape':
            case 'html': return [text(token.text)];
            case 'strong':
            case 'em':
            case 'del':
            case 'blockquote': return [element(token.type, children(token.tokens))];
            case 'br':
            case 'hr': return [element(token.type, [])];
            case 'codespan': return [element('code', [text(token.text)])];
            case 'code': return [{ tag: 'pre', language: String(token.lang ?? '').split(/\s/)[0].slice(0, 40), children: [element('code', [text(token.text)])] }];
            case 'link':
            case 'image': {
                const content = token.type === 'image' ? [text('图片：' + token.text)] : children(token.tokens);
                try {
                    const url = new URL(token.href);
                    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
                        return [{ tag: 'a', href: url.href, children: content }];
                }
                catch { /* Local paths and invalid URLs stay readable text. */ }
                return content;
            }
            case 'list': return [{ tag: token.ordered ? 'ol' : 'ul', ...(token.ordered ? { start: Number(token.start) } : {}), children: token.items.map((item) => element('li', [
                        ...(item.task ? [{ tag: 'checkbox', checked: item.checked === true }] : []), ...children(item.tokens),
                    ])) }];
            case 'table': return [element('table', [
                    element('thead', [element('tr', token.header.map((cell) => element('th', children(cell.tokens))))]),
                    element('tbody', token.rows.map((row) => element('tr', row.map((cell) => element('td', children(cell.tokens)))))),
                ])];
            default: return [text(token.raw)];
        }
    });
    let result;
    try {
        result = tokens(marked.lexer(message.text, { gfm: true }));
    }
    catch {
        result = [element('p', [text(message.text)])];
    }
    cache.set(message, result);
    return result;
}
export const GROUP_MARKDOWN_SCRIPT = `
function groupMarkdownBody(nodes, original) {
  var root=textNode('div','','group-markdown'),budget=4000;
  function append(parent,items,depth) {
    if(!Array.isArray(items)||depth>24)return;
    items.forEach(function(item){
      if(!item||--budget<0)return;
      if(typeof item.text==='string'){
        parent.append(document.createTextNode(item.text));return;
      }
      if(!['p','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','br','hr','code','pre','a','ol','ul','li','table','thead','tbody','tr','th','td','checkbox'].includes(item.tag))return;
      if(item.tag==='checkbox'){var check=document.createElement('input');check.type='checkbox';check.disabled=true;check.checked=item.checked===true;parent.append(check);return;}
      var node=document.createElement(item.tag);
      if(item.tag==='a') {try{var url=new URL(item.href);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password){node.href=url.href;node.target='_blank';node.rel='noopener noreferrer';}}catch(_){}}
      if(item.tag==='ol'&&Number.isSafeInteger(item.start)&&item.start>0)node.start=item.start;
      append(node,item.children,depth+1);
      if(item.tag==='pre'){
        var box=textNode('div','','group-code'),bar=textNode('div','','group-code-bar'),copy=textNode('button','复制代码');copy.type='button';
        copy.onclick=async function(){try{await navigator.clipboard.writeText(node.textContent);copy.textContent='已复制';}catch(_){copy.textContent='复制未成功';}};
        bar.append(textNode('span',item.language||'代码'),copy);box.append(bar,node);parent.append(box);
      }else if(item.tag==='table'){var scroll=textNode('div','','group-table');scroll.append(node);parent.append(scroll);}else parent.append(node);
    });
  }
  append(root,nodes,0);if(!root.childNodes.length)root.textContent=original;
  return root;
}
`;
export const GROUP_MARKDOWN_CSS = `
.group-markdown { line-height:1.75; overflow-wrap:anywhere; }
.group-markdown p { white-space:normal; margin:0 0 12px; }
.group-markdown > :last-child { margin-bottom:0; }
.group-markdown h1,.group-markdown h2,.group-markdown h3,.group-markdown h4,.group-markdown h5,.group-markdown h6 { margin:20px 0 10px; line-height:1.4; }
.group-markdown > :first-child { margin-top:0; }
.group-markdown h1 { font-size:22px; }.group-markdown h2 { font-size:19px; }.group-markdown h3 { font-size:16px; }
.group-markdown strong { color:var(--text); }
.group-markdown ul,.group-markdown ol { margin:8px 0 14px; padding-left:24px; }
.group-markdown li { margin:4px 0; }.group-markdown li p { margin:4px 0; }
.group-markdown blockquote { margin:14px 0; border-left:3px solid var(--accent); padding:4px 14px; color:var(--muted); }
.group-markdown a { color:var(--accent); text-decoration:underline; text-underline-offset:3px; }
.group-markdown code { font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); border-radius:4px; padding:2px 5px; }
.group-code { margin:12px 0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--bg); }
.group-code-bar { display:flex; justify-content:space-between; align-items:center; padding:6px 12px; color:var(--muted); font-size:11px; border-bottom:1px solid var(--line); }
.group-code-bar button { border:0; padding:3px 7px; font-size:11px; background:transparent; }
.group-markdown pre { margin:0; padding:14px; overflow-x:auto; white-space:pre; }
.group-markdown pre code { padding:0; border-radius:0; background:none; }
.group-table { overflow-x:auto; margin:14px 0; }.group-markdown table { border-collapse:collapse; font-size:13px; width:100%; }
.group-markdown th,.group-markdown td { border:1px solid var(--line); padding:8px 12px; text-align:left; }
.group-markdown th { background:var(--hover); }.group-markdown hr { border:0; border-top:1px solid var(--line); margin:18px 0; }
.group-markdown input[type=checkbox] { margin-right:7px; }
`;
