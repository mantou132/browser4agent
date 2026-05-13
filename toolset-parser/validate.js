import ts from 'typescript';
import { assertNoParseErrors, ValidationError } from './error.js';

const SCHEMA_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

export function validateToolset(toolset) {
  if (!toolset.name) throw new ValidationError('Toolset must have a name (from @module tag)');
  if (!toolset.tools.length) throw new ValidationError('Toolset must contain at least one function tool');

  const names = new Set();
  for (const tool of toolset.tools) {
    if (!tool.name) throw new ValidationError('Each tool must have a function name');
    if (names.has(tool.name)) throw new ValidationError(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);

    if (!tool.description) throw new ValidationError(`Tool "${tool.name}" must have a description`);
    if (!tool.pattern) throw new ValidationError(`Tool "${tool.name}" must have a @pattern tag`);
    validatePattern(tool);
    validateInputSchema(tool);
    if (!tool.execute) throw new ValidationError(`Tool "${tool.name}" must have an execute function`);
    validateExecuteSyntax(tool);
  }
}

function validatePattern(tool) {
  if (typeof URLPattern !== 'function') return;

  try {
    new URLPattern(tool.pattern);
  } catch (err) {
    throw new ValidationError(`Tool "${tool.name}" has an invalid @pattern: ${err.message}`);
  }
}

function validateInputSchema(tool) {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') throw new ValidationError(`Tool "${tool.name}" must have an inputSchema`);
  if (schema.type !== 'object') throw new ValidationError(`Tool "${tool.name}" inputSchema must be an object schema`);
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    throw new ValidationError(`Tool "${tool.name}" inputSchema must have object properties`);
  }
  if (schema.required && !Array.isArray(schema.required)) {
    throw new ValidationError(`Tool "${tool.name}" inputSchema.required must be an array`);
  }

  for (const [name, prop] of Object.entries(schema.properties)) {
    if (!prop || typeof prop !== 'object')
      throw new ValidationError(`Tool "${tool.name}" property "${name}" must be an object`);
    if (!SCHEMA_TYPES.has(prop.type)) {
      throw new ValidationError(`Tool "${tool.name}" property "${name}" has unsupported type: ${prop.type}`);
    }
  }

  for (const name of schema.required || []) {
    if (typeof name !== 'string')
      throw new ValidationError(`Tool "${tool.name}" inputSchema.required must contain strings`);
    if (!Object.hasOwn(schema.properties, name)) {
      throw new ValidationError(`Tool "${tool.name}" requires unknown property: ${name}`);
    }
  }
}

function validateExecuteSyntax(tool) {
  const sourceFile = ts.createSourceFile(
    `${tool.name}.execute.js`,
    `const execute = ${tool.execute};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assertNoParseErrors(sourceFile, `Tool "${tool.name}" generated an invalid execute expression`);
}
