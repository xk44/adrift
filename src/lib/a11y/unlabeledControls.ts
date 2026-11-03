/**
 * Static scan for icon-only controls and form fields without an accessible
 * name.
 *
 * A <button>, <a href> or role="button" element is "unlabeled" when it has no
 * aria-label / aria-labelledby / title and nothing inside it can render text:
 * only icons, images without alt, or aria-hidden content. Any `{expression}`
 * child is assumed to render text (we can't evaluate it), so the scan errs on
 * the side of silence. Used by __tests__/unlabeledControls.test.ts.
 *
 * Node-only (imports the TypeScript compiler) — never import from app code.
 */
import ts from "typescript";

export interface UnlabeledControl {
  file: string;
  line: number;
  tag: string;
}

const LABEL_ATTRS = new Set(["aria-label", "aria-labelledby", "title"]);

type JsxOpening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attrs(el: JsxOpening): ts.JsxAttributes {
  return el.attributes;
}

function attrValue(el: JsxOpening, name: string): ts.JsxAttribute | undefined {
  for (const p of attrs(el).properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === name) return p;
  }
  return undefined;
}

function hasSpread(el: JsxOpening): boolean {
  return attrs(el).properties.some((p) => ts.isJsxSpreadAttribute(p));
}

function isAriaHidden(el: JsxOpening): boolean {
  const a = attrValue(el, "aria-hidden");
  if (!a) return false;
  if (!a.initializer) return true; // bare `aria-hidden`
  const init = a.initializer;
  if (ts.isStringLiteral(init)) return init.text === "true";
  if (ts.isJsxExpression(init) && init.expression) {
    return init.expression.kind === ts.SyntaxKind.TrueKeyword;
  }
  return false;
}

function isLabelled(el: JsxOpening): boolean {
  if (hasSpread(el)) return true; // props forwarded — can't tell
  for (const p of attrs(el).properties) {
    if (!ts.isJsxAttribute(p)) continue;
    const n = p.name.getText();
    if (LABEL_ATTRS.has(n) || n === "children") return true;
  }
  return false;
}

function tagName(el: JsxOpening): string {
  return el.tagName.getText();
}

/** Can this expression render text? Conservative: unknown → yes. */
function exprHasText(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  if (ts.isParenthesizedExpression(e)) return exprHasText(e.expression);
  if (
    ts.isJsxElement(e) ||
    ts.isJsxSelfClosingElement(e) ||
    ts.isJsxFragment(e)
  ) {
    return nodeHasText(e);
  }
  if (ts.isConditionalExpression(e)) {
    // Both branches must be checked: an icon/text toggle is labelled only if
    // every branch is.
    return exprHasText(e.whenTrue) && exprHasText(e.whenFalse);
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken)
      return exprHasText(e.right);
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return exprHasText(e.left) || exprHasText(e.right);
    }
    return true;
  }
  if (e.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(e) && e.text === "undefined") return false;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text.trim().length > 0;
  }
  return true;
}

function childrenHaveText(children: ts.NodeArray<ts.JsxChild>): boolean {
  for (const c of children) {
    if (ts.isJsxText(c)) {
      if (c.text.trim().length > 0) return true;
    } else if (ts.isJsxExpression(c)) {
      if (exprHasText(c.expression)) return true;
    } else if (nodeHasText(c)) {
      return true;
    }
  }
  return false;
}

/** Does this JSX subtree contribute to an accessible name? */
function nodeHasText(
  n: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
): boolean {
  if (ts.isJsxFragment(n)) return childrenHaveText(n.children);
  const open = ts.isJsxElement(n) ? n.openingElement : n;
  if (isAriaHidden(open)) return false;
  const tag = tagName(open);
  if (tag === "img") {
    const alt = attrValue(open, "alt");
    if (!alt) return false;
    if (alt.initializer && ts.isStringLiteral(alt.initializer)) {
      return alt.initializer.text.trim().length > 0;
    }
    return true;
  }
  // A labelled child (e.g. <svg aria-label>, <Icon title>) names the control.
  for (const p of attrs(open).properties) {
    if (ts.isJsxAttribute(p)) {
      const name = p.name.getText();
      if (name === "aria-label" || name === "aria-labelledby") return true;
    }
  }
  if (ts.isJsxSelfClosingElement(n)) {
    // <Foo label="..."/> style components usually render their label.
    return ["label", "text"].some((a) => attrValue(open, a) !== undefined);
  }
  return childrenHaveText(n.children);
}

function isControl(open: JsxOpening): string | null {
  const tag = tagName(open);
  if (tag === "button") return "button";
  if (tag === "a" && attrValue(open, "href")) return "a";
  const role = attrValue(open, "role");
  if (
    role?.initializer &&
    ts.isStringLiteral(role.initializer) &&
    role.initializer.text === "button" &&
    /^[a-z]/.test(tag)
  ) {
    return `${tag}[role=button]`;
  }
  return null;
}

const FIELD_TAGS = new Set(["input", "textarea", "select"]);
const UNNAMED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

/** Is this <input>/<textarea>/<select> missing a programmatic label? */
function isUnlabeledField(open: JsxOpening, insideLabel: boolean): boolean {
  if (!FIELD_TAGS.has(tagName(open))) return false;
  if (insideLabel || isLabelled(open) || isAriaHidden(open)) return false;
  const type = attrValue(open, "type");
  if (
    type?.initializer &&
    ts.isStringLiteral(type.initializer) &&
    UNNAMED_INPUT_TYPES.has(type.initializer.text)
  ) {
    return false;
  }
  // Visually hidden file pickers are driven by a labelled button.
  const cls = attrValue(open, "className");
  if (
    cls?.initializer &&
    ts.isStringLiteral(cls.initializer) &&
    /(^|\s)hidden(\s|$)/.test(cls.initializer.text)
  ) {
    return false;
  }
  // An id is assumed to pair with a <label htmlFor> somewhere.
  return attrValue(open, "id") === undefined;
}

export function scanSource(file: string, source: string): UnlabeledControl[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: UnlabeledControl[] = [];
  const visit = (node: ts.Node, insideLabel = false) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      if (isUnlabeledField(open, insideLabel)) {
        const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
        out.push({ file, line: line + 1, tag: tagName(open) });
      }
      if (ts.isJsxElement(node) && tagName(open) === "label") {
        ts.forEachChild(node, (c) => visit(c, true));
        return;
      }
      const kind = isControl(open);
      if (kind && !isAriaHidden(open) && !isLabelled(open)) {
        const hasText = ts.isJsxElement(node)
          ? childrenHaveText(node.children)
          : false;
        if (!hasText) {
          const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
          out.push({ file, line: line + 1, tag: kind });
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, insideLabel));
  };
  visit(sf);
  return out;
}
