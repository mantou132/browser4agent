import ts from 'typescript';
import { extractModuleInfo, findTagText, getCommentText, getToolDoc } from './comments.js';
import { assertNoParseErrors, ValidationError } from './error.js';
import { buildExecuteString } from './execute.js';
import { buildInputSchema } from './schema.js';
import { validateToolset } from './validate.js';

/**
 * Parse a toolset JS/TS file and return a toolset JSON object.
 * Uses TypeScript compiler API to extract JSDoc metadata and function bodies.
 */
export function parseToolsetJs(jsContent, filename = 'toolset.js') {
  const scriptKind = filename.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(filename, jsContent, ts.ScriptTarget.Latest, true, scriptKind);
  assertNoParseErrors(sourceFile, `Invalid ${scriptKind === ts.ScriptKind.TS ? 'TypeScript' : 'JavaScript'}`);

  const functions = sourceFile.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name);
  const toolFunctions = functions.filter(isExported);
  const moduleInfo = extractModuleInfo(sourceFile);
  const tools = toolFunctions.map((node) => extractTool(sourceFile, node, scriptKind));

  const result = {
    name: moduleInfo.name || '',
    description: moduleInfo.description || '',
    icon: moduleInfo.icon || '',
    author: moduleInfo.author,
    tools,
  };

  validateToolset(result);
  return result;
}

function extractTool(sourceFile, node, scriptKind) {
  const doc = getToolDoc(node);
  return {
    name: node.name.text,
    description: getCommentText(doc) || findTagText(doc, 'description'),
    pattern: findTagText(doc, 'pattern'),
    inputSchema: buildInputSchema(doc),
    execute: buildExecuteString(node, sourceFile, scriptKind),
  };
}

export { ValidationError };

function isExported(node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
