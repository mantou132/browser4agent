import ts from 'typescript';

export function extractModuleInfo(sourceFile) {
  const moduleDoc = sourceFile.statements.flatMap(getJSDocs).find((doc) => findTag(doc, 'module'));
  const author = parseAuthor(findTagText(moduleDoc, 'author'), findTagText(moduleDoc, 'email'));
  return {
    name: findTagText(moduleDoc, 'module'),
    description: findTagText(moduleDoc, 'description') || getCommentText(moduleDoc),
    icon: findTagText(moduleDoc, 'icon'),
    author,
  };
}

export function getToolDoc(node) {
  return [...getJSDocs(node)].reverse().find((doc) => !findTag(doc, 'module'));
}

export function findTagText(doc, tagName) {
  return cleanComment(findTag(doc, tagName)?.comment);
}

export function getCommentText(doc) {
  return cleanComment(doc?.comment);
}

export function cleanComment(comment) {
  return (ts.getTextOfJSDocComment(comment) || '').replace(/^\s*-\s*/, '').trim();
}

// Unescape @pattern in JSDoc: \/ -> / (avoids closing the surrounding block comment).
export function unescapePattern(pattern) {
  return (pattern || '').replace(/\\\//g, '/');
}

function getJSDocs(node) {
  return node.jsDoc ? [...node.jsDoc] : [];
}

function findTag(doc, tagName) {
  return [...(doc?.tags || [])].find((tag) => tag.tagName.text === tagName);
}

function parseAuthor(author = '', emailTag = '') {
  const email =
    emailTag ||
    author
      .match(/<([^<>\s]+@[^<>\s]+)>|([^\s<>]+@[^\s<>]+)/)
      ?.slice(1)
      .find(Boolean) ||
    '';
  const name = author
    .replace(/<[^<>]*>/g, '')
    .replace(/[^\s<>]+@[^\s<>]+/g, '')
    .trim();
  if (!name && !email) return undefined;
  return { name, email };
}
