import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOURCE_ROOTS = ['src', 'tests', 'bench', 'scripts', path.join('packages', 'contracts', 'src'), path.join('dashboard', 'src'), path.join('dashboard', 'tests')];

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /.(?:ts|tsx|mts)$/u.test(entry.name) && !entry.name.endsWith('.d.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !path.relative(directory, file).split(path.sep).some((segment) => segment === 'node_modules' || segment.startsWith('.')));
}

function relativeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
          : undefined;
    if (literal !== undefined && ts.isStringLiteral(literal) && /^\.{1,2}\//u.test(literal.text)) {
      found.push(literal.text.split('?')[0] ?? '');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('every relative import names an existing file, so Node runs the sources without a build', () => {
  const unresolved = SOURCE_ROOTS.flatMap(listSourceFiles).flatMap((file) => relativeSpecifiers(file)
    .filter((specifier) => !fs.statSync(path.resolve(path.dirname(file), specifier), { throwIfNoEntry: false })?.isFile())
    .map((specifier) => `${file}: ${specifier}`));
  assert.deepEqual(unresolved, []);
});
