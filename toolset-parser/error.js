import ts from 'typescript';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function assertNoParseErrors(sourceFile, prefix) {
  if (!sourceFile.parseDiagnostics.length) return;
  throw new ValidationError(`${prefix}: ${formatDiagnostic(sourceFile, sourceFile.parseDiagnostics[0])}`);
}

export function formatDiagnostic(sourceFile, diagnostic) {
  const message = formatDiagnosticText(diagnostic);
  if (diagnostic.start === undefined) return message;

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return `${message} (${line + 1}:${character + 1})`;
}

export function formatDiagnosticText(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}
