import ts from 'typescript';
import { assertNoParseErrors, formatDiagnosticText, ValidationError } from './error.js';

export function buildExecuteString(funcNode, sourceFile, scriptKind) {
  if (funcNode.asteriskToken) throw new ValidationError(`Tool "${funcNode.name.text}" cannot be a generator function`);

  const bodyNode = funcNode.body;
  if (!bodyNode) return 'async () => {}';

  const paramsText = funcNode.parameters.map((param) => param.getText(sourceFile)).join(', ');
  const dependencyText = collectDependencyText(funcNode, sourceFile);
  const bodyText = dependencyText
    ? `{\n${dependencyText}\n${bodyNode.getText(sourceFile).slice(1)}`
    : bodyNode.getText(sourceFile);
  const execute = `async (${paramsText}) => ${bodyText}`;

  return scriptKind === ts.ScriptKind.TS ? transpileExecute(funcNode.name.text, execute) : execute;
}

function collectDependencyText(funcNode, sourceFile) {
  const declarations = getTopLevelDeclarations(sourceFile, funcNode);
  const imports = getImportedNames(sourceFile);
  const dependencies = collectDependencies(funcNode, declarations, imports, new Set(), funcNode.name.text);
  return dependencies.map((node) => trimExport(node.getText(sourceFile))).join('\n');
}

function getTopLevelDeclarations(sourceFile, toolNode) {
  const declarations = new Map();

  for (const statement of sourceFile.statements) {
    if (statement === toolNode) continue;
    if (isDeclare(statement) || isImport(statement)) continue;

    for (const name of getTopLevelNames(statement)) {
      declarations.set(name, statement);
    }
  }

  return declarations;
}

function getImportedNames(sourceFile) {
  const names = new Set();

  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement)) names.add(statement.name.text);
    if (!ts.isImportDeclaration(statement)) continue;

    const clause = statement.importClause;
    if (clause?.name) names.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) names.add(element.name.text);
    }
  }

  return names;
}

function getTopLevelNames(statement) {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
    return statement.name ? [statement.name.text] : [];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
  }
  return [];
}

function collectDependencies(node, declarations, imports, seen, toolName) {
  const dependencies = [];

  visitRefs(node, (name) => {
    if (imports.has(name)) {
      throw new ValidationError(`Tool "${toolName}" references imported "${name}", which cannot be inlined`);
    }

    const declaration = declarations.get(name);
    if (!declaration || seen.has(declaration)) return;

    seen.add(declaration);
    dependencies.push(...collectDependencies(declaration, declarations, imports, seen, toolName), declaration);
  });

  return dependencies;
}

function visitRefs(node, visit, parentLocals = new Set()) {
  if (isTypeOnlyNode(node)) return;

  const locals = getScopeLocals(node, parentLocals);
  if (isDeclarationName(node) || isPropertyName(node)) return;
  if (ts.isIdentifier(node) && !locals.has(node.text)) visit(node.text);

  ts.forEachChild(node, (child) => visitRefs(child, visit, locals));
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => bindingNames(element.name));
  }
  return [];
}

function isDeclarationName(node) {
  const parent = node.parent;
  return (
    ts.isIdentifier(node) &&
    ((ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isEnumDeclaration(parent) && parent.name === node) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isPropertyDeclaration(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isFunctionExpression(parent) && parent.name === node))
  );
}

function isPropertyName(node) {
  const parent = node.parent;
  return (
    ts.isIdentifier(node) &&
    ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isPropertySignature(parent) && parent.name === node) ||
      (ts.isPropertyDeclaration(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.propertyName === node))
  );
}

function getScopeLocals(node, parentLocals) {
  if (!createsScope(node)) return parentLocals;

  const locals = new Set(parentLocals);
  if (isFunctionLike(node)) {
    if (node.name) locals.add(node.name.text);
    for (const param of node.parameters) {
      for (const name of bindingNames(param.name)) locals.add(name);
    }
  }
  collectLocalDeclarations(node, locals);
  return locals;
}

function collectLocalDeclarations(scope, locals) {
  const visit = (node) => {
    if (node !== scope && createsScope(node)) {
      if (node.name) locals.add(node.name.text);
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.name)) locals.add(name);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      locals.add(node.name.text);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(scope, visit);
}

function createsScope(node) {
  return ts.isBlock(node) || isFunctionLike(node);
}

function isFunctionLike(node) {
  return ts.isFunctionLike(node);
}

function isTypeOnlyNode(node) {
  let current = node;
  while (current.parent) {
    current = current.parent;
    if (
      ts.isTypeNode(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isHeritageClause(current)
    ) {
      return true;
    }
    if (ts.isStatement(current) || ts.isExpression(current)) return false;
  }
  return false;
}

function trimExport(text) {
  return text.replace(/^export\s+default\s+/, '').replace(/^export\s+/, '');
}

function isDeclare(node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

function isImport(node) {
  return ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node);
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
