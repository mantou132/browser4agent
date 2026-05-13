import ts from 'typescript';
import { assertNoParseErrors, formatDiagnosticText, ValidationError } from './error.js';

export function buildExecuteString(funcNode, sourceFile, scriptKind) {
  if (funcNode.asteriskToken) throw new ValidationError(`Tool "${funcNode.name.text}" cannot be a generator function`);

  const paramsText = funcNode.parameters.map((p) => p.getText(sourceFile)).join(', ');
  const bodyNode = funcNode.body;
  if (!bodyNode) return 'async () => {}';

  const execute = `async (${paramsText}) => ${bodyNode.getText(sourceFile)}`;
  return scriptKind === ts.ScriptKind.TS ? transpileExecute(funcNode.name.text, execute) : execute;
}

function transpileExecute(toolName, execute) {
  const result = ts.transpileModule(`const execute = ${execute};`, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      removeComments: true,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const diagnostic = result.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostic) {
    throw new ValidationError(`Tool "${toolName}" generated invalid TypeScript: ${formatDiagnosticText(diagnostic)}`);
  }

  const sourceFile = ts.createSourceFile(
    `${toolName}.execute.js`,
    result.outputText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assertNoParseErrors(sourceFile, `Tool "${toolName}" generated invalid JavaScript`);

  const statement = sourceFile.statements[0];
  const declaration = ts.isVariableStatement(statement) && statement.declarationList.declarations[0];
  if (!declaration?.initializer) {
    throw new ValidationError(`Tool "${toolName}" generated an invalid execute expression`);
  }
  return declaration.initializer.getText(sourceFile);
}
