import { fnv1a } from 'duoyun-ui/lib/encode';

export function toolKey(toolsetId, toolName) {
  return `${toolsetId}.${toolName}`;
}

export function getToolsetId(url) {
  return String(fnv1a(url));
}

export function isToolEnabled(toolStates, toolsetId, toolName) {
  return toolStates[toolKey(toolsetId, toolName)] !== false;
}

export function isToolsetLiked(likedToolsets, toolsetId) {
  return likedToolsets[toolsetId] === true;
}
