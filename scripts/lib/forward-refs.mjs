/**
 * Find bindings that are *read while a closure is still running* but declared
 * later in it — the temporal-dead-zone fault, statically.
 *
 * **Why this exists.** `index.ts` is one 4,700-line closure, and CLAUDE.md is
 * explicit that its problem is ordering rather than size: three bugs in a
 * single session were use-before-declaration inside it. `astro check` cannot
 * see any of them, because TypeScript does not track whether a closure's
 * statements have run by the time a reference is evaluated.
 *
 * **What it catches, precisely:** a read at the closure's own statement level
 * — code that executes as the map is built — of a `const` or `let` declared
 * further down. That is a `ReferenceError` on load: the map half-builds and
 * the page is blank.
 *
 * **What it deliberately does not catch:** the same reference inside a
 * function body. Those are deferred, they are how the whole file works, and
 * there are 632 of them — flagging those would bury the real thing and the
 * gate would be switched off within a week. It is the difference between
 * `measure.ts`, which was declared 700 lines below one of its callers and
 * *worked* because a click handler cannot run during setup, and a genuine
 * crash. Only the second is a fault; the first is a smell the refactor is
 * for.
 *
 * `function` declarations are exempt, and that is not an oversight: they are
 * hoisted and initialised before any statement runs, so a reference above one
 * is legal and does work.
 *
 * **It uses TypeScript's own parser**, which is already a devDependency. A
 * first version counted braces and reported zero declarations in a file with
 * 182 of them — the parameter default `options: OceanMapOptions = {}` meant
 * "the first `{` after the signature" was the wrong brace. Expression-bodied
 * arrows would have been the next thing to get wrong. A real AST costs
 * nothing here and cannot drift.
 */
import ts from 'typescript';

/**
 * @param {string} source
 * @param {string} path      for the parser's own diagnostics
 * @param {string} functionName the closure to inspect
 * @returns {{ problems: {name: string, usedAt: number, declaredAt: number}[],
 *             declarations: number, reads: number }}
 */
export function forwardReferences(source, path, functionName) {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  let target;
  const findFn = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) target = node;
    else ts.forEachChild(node, findFn);
  };
  ts.forEachChild(sf, findFn);
  if (!target?.body) {
    /* Loudly, rather than returning "no problems". A renamed function would
       otherwise turn this into a check that passes because it looked at
       nothing — the shape CLAUDE.md's own list warns about twice. */
    throw new Error(`forward-refs: no function body found for ${functionName} in ${path}`);
  }

  const declarations = new Map();
  for (const statement of target.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const flags = statement.declarationList.flags;
    if (!(flags & ts.NodeFlags.Const) && !(flags & ts.NodeFlags.Let)) continue;
    for (const d of statement.declarationList.declarations) {
      const collect = (name) => {
        if (ts.isIdentifier(name)) declarations.set(name.text, lineOf(statement));
        else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
          for (const el of name.elements) if (ts.isBindingElement(el)) collect(el.name);
        }
      };
      collect(d.name);
    }
  }

  const reads = [];
  const walk = (node, deferred) => {
    const defersChildren =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node);

    if (!deferred && ts.isIdentifier(node)) {
      const parent = node.parent;
      /* A name being *written* is not a read: the left of a declaration, a
         property key, `foo` in `bar.foo`. Missing these would report every
         declaration as a reference to itself. */
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node);
      // A type annotation is erased and never runs.
      let inType = false;
      for (let a = parent; a; a = a.parent) {
        if (ts.isTypeNode(a) || ts.isTypeAliasDeclaration(a) || ts.isInterfaceDeclaration(a)) {
          inType = true;
          break;
        }
      }
      if (!isName && !inType) reads.push({ name: node.text, line: lineOf(node) });
    }

    ts.forEachChild(node, (child) => walk(child, deferred || defersChildren));
  };
  for (const statement of target.body.statements) walk(statement, false);

  const problems = [];
  for (const read of reads) {
    const declaredAt = declarations.get(read.name);
    if (declaredAt !== undefined && read.line < declaredAt) {
      problems.push({ name: read.name, usedAt: read.line, declaredAt });
    }
  }
  return { problems, declarations: declarations.size, reads: reads.length };
}
