const KEY_ATTRIBUTES = [
  "id",
  "data-render-key",
  "data-deadline-id",
  "data-exam-id",
  "data-study-checkpoint",
  "data-kif-open",
];

const nodeKey = (node) => {
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  for (const attribute of KEY_ATTRIBUTES) {
    const value = node.getAttribute(attribute);
    if (value) return `${node.tagName}:${attribute}:${value}`;
  }
  return "";
};

const compatibleNodes = (current, desired) => {
  if (!current || current.nodeType !== desired.nodeType) return false;
  if (current.nodeType !== Node.ELEMENT_NODE) return true;
  if (current.tagName !== desired.tagName) return false;
  const currentKey = nodeKey(current);
  const desiredKey = nodeKey(desired);
  return currentKey || desiredKey ? currentKey === desiredKey : true;
};

const syncAttributes = (current, desired, preserveValue) => {
  for (const attribute of [...current.attributes]) {
    if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }

  for (const attribute of [...desired.attributes]) {
    if (preserveValue && attribute.name === "value") continue;
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
};

const reconcileChildren = (parent, desiredParent) => {
  const originalChildren = [...parent.childNodes];
  const keyedChildren = new Map(
    originalChildren.map((node) => [nodeKey(node), node]).filter(([key]) => Boolean(key)),
  );
  const used = new Set();
  const desiredChildren = [...desiredParent.childNodes];

  desiredChildren.forEach((desired, index) => {
    const key = nodeKey(desired);
    let current = key ? keyedChildren.get(key) : parent.childNodes[index];

    if (!compatibleNodes(current, desired) || used.has(current)) {
      current = originalChildren.find((candidate) => (
        !used.has(candidate) && compatibleNodes(candidate, desired)
      ));
    }

    if (!current) {
      current = desired.cloneNode(true);
      parent.insertBefore(current, parent.childNodes[index] || null);
      used.add(current);
      return;
    }

    used.add(current);
    if (parent.childNodes[index] !== current) {
      parent.insertBefore(current, parent.childNodes[index] || null);
    }
    patchNode(current, desired);
  });

  while (parent.childNodes.length > desiredChildren.length) {
    parent.removeChild(parent.lastChild);
  }
};

const patchNode = (current, desired) => {
  if (current.nodeType !== Node.ELEMENT_NODE) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return;
  }

  const activeElement = current.ownerDocument.activeElement;
  const preserveValue = current === activeElement
    && /^(INPUT|TEXTAREA|SELECT)$/.test(current.tagName);
  syncAttributes(current, desired, preserveValue);

  if (current instanceof HTMLInputElement) {
    current.checked = desired.checked;
    current.indeterminate = desired.indeterminate;
    if (!preserveValue) current.value = desired.value;
  } else if (current instanceof HTMLTextAreaElement) {
    if (!preserveValue) current.value = desired.value;
  } else if (current instanceof HTMLSelectElement && !preserveValue) {
    current.value = desired.value;
  }

  if (!preserveValue && !current.isContentEditable) reconcileChildren(current, desired);
};

export const shouldPatchMarkup = (previousMarkup, nextMarkup) => (
  String(previousMarkup || "") !== String(nextMarkup || "")
);

export const patchRootHtml = (root, markup) => {
  const scrollPositions = [root, ...root.querySelectorAll("*")]
    .filter((element) => element.scrollTop || element.scrollLeft)
    .map((element) => ({ element, left: element.scrollLeft, top: element.scrollTop }));
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = markup.trim();
  reconcileChildren(root, template.content);

  for (const position of scrollPositions) {
    if (!position.element.isConnected) continue;
    position.element.scrollTop = Math.min(
      position.top,
      Math.max(0, position.element.scrollHeight - position.element.clientHeight),
    );
    position.element.scrollLeft = Math.min(
      position.left,
      Math.max(0, position.element.scrollWidth - position.element.clientWidth),
    );
  }
};
