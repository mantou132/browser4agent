import ts from 'typescript';
import { cleanComment } from './comments.js';
import { ValidationError } from './error.js';

export function buildInputSchema(doc) {
  const properties = {};
  const required = [];

  if (!doc) return { type: 'object', properties };

  const paramTags = [...(doc.tags || [])].filter(ts.isJSDocParameterTag);
  addOptionTypeProperties(paramTags, properties, required);
  addOptionParamProperties(paramTags, properties, required);

  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

export function unwrapTypeNode(typeNode) {
  if (!typeNode) return undefined;

  let node = typeNode;
  while (
    ts.isParenthesizedTypeNode(node) ||
    node.kind === ts.SyntaxKind.JSDocNonNullableType ||
    node.kind === ts.SyntaxKind.JSDocNullableType ||
    node.kind === ts.SyntaxKind.JSDocOptionalType
  ) {
    node = node.type;
  }
  return node;
}

function addOptionTypeProperties(paramTags, properties, required) {
  for (const tag of paramTags) {
    if (tag.name.getText() !== 'options') continue;

    const type = unwrapTypeNode(tag.typeExpression?.type);
    if (!type || !ts.isTypeLiteralNode(type)) continue;

    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;

      const propName = member.name.getText().replace(/^['"]|['"]$/g, '');
      properties[propName] = {
        type: jsDocTypeToJsonSchemaType(member.type, propName),
        description: '',
      };
      if (!member.questionToken) required.push(propName);
    }
  }
}

function addOptionParamProperties(paramTags, properties, required) {
  for (const tag of paramTags) {
    const name = tag.name.getText();
    if (!name.startsWith('options.')) continue;

    const propName = name.slice('options.'.length);
    if (!propName) continue;

    properties[propName] = {
      type: jsDocTypeToJsonSchemaType(tag.typeExpression?.type, propName),
      description: cleanComment(tag.comment),
    };
    if (!tag.isBracketed && !required.includes(propName)) required.push(propName);
    if (tag.isBracketed) remove(required, propName);
  }
}

function jsDocTypeToJsonSchemaType(typeNode, propName) {
  const schemaType = getSchemaType(typeNode);
  if (schemaType) return schemaType;

  const typeText = typeNode?.getText() || 'missing';
  throw new ValidationError(`Unsupported @param type for options.${propName}: ${typeText}`);
}

function getSchemaType(typeNode) {
  if (!typeNode) return '';

  const node = unwrapTypeNode(typeNode);

  if (ts.isArrayTypeNode(node)) return 'array';
  if (ts.isTypeLiteralNode(node)) return 'object';
  if (ts.isUnionTypeNode(node)) {
    const types = [...new Set(node.types.map(getSchemaType).filter(Boolean))];
    return types.length === 1 ? types[0] : '';
  }
  if (ts.isTypeReferenceNode(node)) {
    return (
      { array: 'array', object: 'object', string: 'string', number: 'number', boolean: 'boolean' }[
        node.typeName.getText().toLowerCase()
      ] || ''
    );
  }

  return (
    {
      [ts.SyntaxKind.StringKeyword]: 'string',
      [ts.SyntaxKind.NumberKeyword]: 'number',
      [ts.SyntaxKind.BooleanKeyword]: 'boolean',
      [ts.SyntaxKind.ObjectKeyword]: 'object',
    }[node.kind] || ''
  );
}

function remove(arr, value) {
  const index = arr.indexOf(value);
  if (index >= 0) arr.splice(index, 1);
}
