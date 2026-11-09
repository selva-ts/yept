import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

it('keeps Electron imports inside the desktop host, including tooling and type imports', () => {
  const root = resolve(__dirname, '../../../..');
  const host = join(root, 'apps/desktop/src/host') + sep;
  const violations: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', '.vscode-test', 'dist', 'out'].includes(entry.name)) walk(file); continue; }
      if (!/\.(?:[cm]?js|tsx?)$/.test(file) || file.startsWith(host)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        let specifier: ts.Node | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) specifier = node.arguments[0];
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
        if (specifier && ts.isStringLiteral(specifier) && (specifier.text === 'electron' || specifier.text.startsWith('electron/'))) violations.push(relative(root, file));
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  for (const dir of ['apps', 'packages', 'scripts']) walk(join(root, dir));
  expect(violations).toEqual([]);
});
