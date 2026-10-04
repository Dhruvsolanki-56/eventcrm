"""Remove old CSS rules that the new design system (client/ui) now owns.

Usage: python scripts/prune-css.py exclusive.txt shared.txt file.css [file.css ...]

exclusive: a selector that mentions any of these classes is dropped (the screen using them was rebuilt).
shared:    a selector is dropped only if every class in it is in this set or in exclusive (generic primitives
           such as .button or .surface-card, whose old rules would otherwise fight the new ones).
"""
import re
import sys

def split_top_level(text, sep=','):
    parts, depth, cur = [], 0, ''
    for ch in text:
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == sep and depth == 0:
            parts.append(cur); cur = ''
        else:
            cur += ch
    parts.append(cur)
    return parts

def classes_in(selector):
    return set(re.findall(r'\.([A-Za-z_][\w-]*)', selector))

def parse(css, i=0, end=None):
    """Yield blocks as (prelude, body, is_nested)."""
    end = len(css) if end is None else end
    out = []
    while i < end:
        # skip whitespace and comments
        m = re.compile(r'\s*(/\*.*?\*/\s*)*', re.S).match(css, i)
        lead = css[i:m.end()]
        i = m.end()
        if i >= end:
            out.append(('', lead, 'tail'))
            break
        j = css.index('{', i)
        prelude = css[i:j]
        depth, k = 1, j + 1
        while depth:
            c = css[k]
            if c == '{': depth += 1
            elif c == '}': depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        out.append((lead + prelude, body, 'block'))
        i = k
    return out

def prune(css, exclusive, shared, stats):
    pieces = []
    for prelude, body, kind in parse(css):
        if kind == 'tail':
            pieces.append(body); continue
        head = prelude.strip()
        core = prelude.lstrip()
        # strip leading comments to find the real prelude
        core = re.sub(r'^(/\*.*?\*/\s*)+', '', core, flags=re.S)
        if core.startswith('@media') or core.startswith('@supports') or core.startswith('@layer'):
            inner = prune(body, exclusive, shared, stats)
            if inner.strip():
                pieces.append(prelude + '{' + inner + '}')
            else:
                stats['dropped'] += 1
            continue
        if core.startswith('@'):
            pieces.append(prelude + '{' + body + '}'); continue
        keep = []
        for selector in split_top_level(core):
            cls = classes_in(selector)
            if cls & exclusive:
                continue
            if cls and cls <= (shared | exclusive):
                continue
            keep.append(selector.strip())
        if keep:
            lead = prelude[:len(prelude) - len(prelude.lstrip())]
            pieces.append(lead + ', '.join(keep) + ' {' + body + '}')
            if len(keep) != len(split_top_level(core)):
                stats['trimmed'] += 1
        else:
            stats['dropped'] += 1
    return ''.join(pieces)

def read_set(path):
    return set(w for w in re.split(r'[\s,]+', open(path, encoding='utf-8').read()) if w)

if __name__ == '__main__':
    exclusive = read_set(sys.argv[1]); shared = read_set(sys.argv[2])
    for path in sys.argv[3:]:
        css = open(path, encoding='utf-8', newline='').read()
        stats = {'dropped': 0, 'trimmed': 0}
        out = prune(css, exclusive, shared, stats)
        open(path, 'w', encoding='utf-8', newline='').write(out)
        print(path, 'dropped', stats['dropped'], 'trimmed', stats['trimmed'], 'size', len(css), '->', len(out))
