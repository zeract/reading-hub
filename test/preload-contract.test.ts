import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS as sharedChannels } from "../src/shared/ipc";

const preloadPath = resolve(process.cwd(), "src/main/preload.ts");
const preloadSource = readFileSync(preloadPath, "utf8");

describe("sandbox preload contract", () => {
  it("keeps the self-contained preload channel map identical to the shared IPC contract", () => {
    const sourceFile = ts.createSourceFile(preloadPath, preloadSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const declaration = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "IPC_CHANNELS");

    expect(declaration?.initializer).toBeDefined();
    expect(readLiteral(declaration!.initializer!)).toEqual(sharedChannels);
  });

  it("does not emit a relative require from the sandboxed preload", () => {
    const emitted = ts.transpileModule(preloadSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;

    const emittedFile = ts.createSourceFile("preload.js", emitted, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const requiredModules = collectRequires(emittedFile);
    expect(requiredModules).not.toContain("../shared/ipc");
    expect(requiredModules).toContain("electron");
    expect(emitted).toContain('contextBridge.exposeInMainWorld("reader", readerApi)');
  });
});

function readLiteral(node: ts.Expression): unknown {
  const unwrapped = unwrap(node);
  if (ts.isStringLiteral(unwrapped)) return unwrapped.text;
  if (!ts.isObjectLiteralExpression(unwrapped)) throw new Error("预加载 IPC 映射必须是对象字面量。");

  return Object.fromEntries(unwrapped.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || !property.name) throw new Error("预加载 IPC 映射不能使用计算属性或展开语法。");
    const key = propertyName(property.name);
    return [key, readLiteral(property.initializer)];
  }));
}

function unwrap(node: ts.Expression): ts.Expression {
  let value = node;
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
  return value;
}

function propertyName(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  throw new Error("预加载 IPC 映射只能包含静态属性名。");
}

function collectRequires(sourceFile: ts.SourceFile): string[] {
  const required = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])) {
      required.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...required];
}
