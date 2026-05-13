import ts from 'typescript';

export function extractModuleInfo(functions) {
  const moduleDoc = functions.flatMap(getJSDocs).find((doc) => findTag(doc, 'module'));
  return {
    name: findTagText(moduleDoc, 'module'),
    description: findTagText(moduleDoc, 'description') || getCommentText(moduleDoc),
    icon: findTagText(moduleDoc, 'icon'),
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

function getJSDocs(node) {
  return node.jsDoc ? [...node.jsDoc] : [];
}

function findTag(doc, tagName) {
  return [...(doc?.tags || [])].find((tag) => tag.tagName.text === tagName);
}
