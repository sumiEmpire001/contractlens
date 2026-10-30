const verbs = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

export function compare(before, after) {
  for (const doc of [before, after]) {
    if (!doc || typeof doc !== 'object' || !/^3\.0\.\d+$/.test(doc.openapi ?? '') || !doc.paths || typeof doc.paths !== 'object' || Array.isArray(doc.paths)) {
      throw new Error('Expected an OpenAPI 3.0.x JSON object with a paths object');
    }
  }
  const findings = [];
  const add = (severity, code, path, message) => findings.push({ severity, code, path, message });
  function resolve(value, doc, trail = []) {
    if (!value || typeof value !== 'object' || !value.$ref) return value ?? {};
    const ref = value.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error('Only local JSON Pointer references are supported');
    if (trail.includes(ref)) throw new Error('Recursive schema references require manual review');
    let result = doc;
    for (const raw of ref.slice(2).split('/')) {
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, key)) throw new Error('Unresolved reference: ' + ref);
      result = result[key];
    }
    return resolve(result, doc, [...trail, ref]);
  }
  function checkedResolve(value, doc, path) {
    try { return resolve(value, doc); }
    catch (error) { add('review', 'reference', path, error.message); return null; }
  }
  const active = new Set();
  function schema(oldValue, newValue, direction, path) {
    const old = checkedResolve(oldValue, before, path);
    const next = checkedResolve(newValue, after, path);
    if (!old || !next) return;
    // Resolve nested references even if the containing schema text is unchanged.
    const signature = direction + ':' + JSON.stringify([old, next]);
    if (active.has(signature)) { add('review', 'recursive-schema', path, 'Recursive schemas require manual review'); return; }
    active.add(signature);
    try {
      if (old.type !== next.type) add('breaking', 'schema-type', path, `Type changed from ${old.type ?? 'unspecified'} to ${next.type ?? 'unspecified'}`);
      const oldNullable = old.nullable === true, newNullable = next.nullable === true;
      if ((direction === 'request' && oldNullable && !newNullable) || (direction === 'response' && !oldNullable && newNullable)) add('breaking', 'nullable', path, 'Nullability changed incompatibly');
      if (direction === 'request' && Array.isArray(next.enum)) {
        if (!Array.isArray(old.enum) || old.enum.some(value => !next.enum.some(v => same(v, value)))) add('breaking', 'enum-narrowed', path, 'Request accepts fewer enum values');
      }
      if (direction === 'response' && Array.isArray(old.enum)) {
        if (!Array.isArray(next.enum) || next.enum.some(value => !old.enum.some(v => same(v, value)))) add('breaking', 'enum-widened', path, 'Response may contain new enum values');
      }
      const oldRequired = new Set(old.required ?? []), newRequired = new Set(next.required ?? []);
      if (direction === 'request') for (const key of newRequired) if (!oldRequired.has(key)) add('breaking', 'required-added', path + '/properties/' + key, 'New required request field');
      if (direction === 'response') for (const key of oldRequired) if (!newRequired.has(key)) add('breaking', 'required-removed', path + '/properties/' + key, 'Response field is no longer guaranteed');
      const oldProps = old.properties ?? {}, newProps = next.properties ?? {};
      for (const [key, value] of Object.entries(oldProps)) {
        if (Object.hasOwn(newProps, key)) schema(value, newProps[key], direction, path + '/properties/' + key);
        else if (direction === 'response') add('breaking', 'property-removed', path + '/properties/' + key, 'Response property removed');
        else if (next.additionalProperties === false) add('breaking', 'property-rejected', path + '/properties/' + key, 'Previously declared request property is now rejected');
      }
      if (direction === 'request') for (const key of Object.keys(newProps)) if (!Object.hasOwn(oldProps, key) && old.additionalProperties !== false) add('review', 'new-property-constraint', path + '/properties/' + key, 'Previously unconstrained request property now has a declared schema');
      if (old.items || next.items) schema(old.items ?? {}, next.items ?? {}, direction, path + '/items');
      const oldAdditional = old.additionalProperties ?? true, newAdditional = next.additionalProperties ?? true;
      if ((direction === 'request' && oldAdditional !== false && newAdditional === false) || (direction === 'response' && oldAdditional === false && newAdditional !== false)) add('breaking', 'additional-properties', path, 'Additional-property policy changed incompatibly');
      if (typeof oldAdditional === 'object' || typeof newAdditional === 'object') {
        if (typeof oldAdditional === 'object' && typeof newAdditional === 'object') schema(oldAdditional, newAdditional, direction, path + '/additionalProperties');
        else if (!same(oldAdditional, newAdditional)) add('review', 'additional-schema', path, 'Changed schema-valued additionalProperties requires review');
      }
      const understood = new Set(['type', 'nullable', 'enum', 'required', 'properties', 'items', 'additionalProperties', 'description', 'title', 'example', 'examples', 'deprecated', 'externalDocs', 'xml']);
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) if (!understood.has(key) && !same(old[key], next[key])) add('review', 'schema-keyword', path + '/' + key, `Changed ${key} is outside the supported comparison subset`);
      // Composition can hide changes in shared component references.
      for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) if (old[key] || next[key]) add('review', 'composition', path + '/' + key, 'Schema composition requires manual review');
      for (const key of ['readOnly', 'writeOnly', 'discriminator']) if (old[key] || next[key]) add('review', 'directional-schema', path + '/' + key, 'Directional and polymorphic schemas require manual review');
    } finally { active.delete(signature); }
  }
  function content(old, next, direction, path) {
    for (const [media, value] of Object.entries(old ?? {})) {
      if (!Object.hasOwn(next ?? {}, media)) add('breaking', 'media-removed', path + '/' + media, 'Previously supported media type removed');
      else schema(value.schema ?? {}, next[media].schema ?? {}, direction, path + '/' + media + '/schema');
    }
    if (direction === 'response') for (const media of Object.keys(next ?? {})) if (!Object.hasOwn(old ?? {}, media)) add('review', 'response-media-added', path + '/' + media, 'New response media type requires client review');
  }
  function parameters(pathItem, operation, doc, path) {
    const result = new Map();
    for (const value of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
      const parameter = checkedResolve(value, doc, path);
      if (parameter) result.set(parameter.in + ':' + parameter.name, parameter);
    }
    return result;
  }
  if (!same(before.security, after.security)) add('review', 'security', '/', 'Global authentication requirements changed');
  if (!same(before.components?.securitySchemes, after.components?.securitySchemes)) add('review', 'security-schemes', '/', 'Authentication scheme definitions changed');
  if (!same(before.servers, after.servers)) add('review', 'servers', '/', 'Server URLs changed');
  for (const [route, oldPathValue] of Object.entries(before.paths)) {
    if (!Object.hasOwn(after.paths, route)) { add('breaking', 'path-removed', route, 'Path removed'); continue; }
    const oldPath = checkedResolve(oldPathValue, before, route), nextPath = checkedResolve(after.paths[route], after, route);
    if (!oldPath || !nextPath) continue;
    for (const method of verbs) {
      const oldOp = oldPath[method];
      if (!oldOp) continue;
      const nextOp = nextPath[method], at = method.toUpperCase() + ' ' + route;
      if (!nextOp) { add('breaking', 'operation-removed', at, 'Operation removed'); continue; }
      if (!same(oldOp.security, nextOp.security)) add('review', 'security', at, 'Operation authentication requirements changed');
      const oldParams = parameters(oldPath, oldOp, before, at), nextParams = parameters(nextPath, nextOp, after, at);
      for (const [key, parameter] of nextParams) {
        if (!oldParams.has(key)) { if (parameter.required) add('breaking', 'parameter-added', at + '/' + key, 'New required parameter'); continue; }
        const previous = oldParams.get(key);
        if (!previous.required && parameter.required) add('breaking', 'parameter-required', at + '/' + key, 'Parameter became required');
        schema(previous.schema ?? {}, parameter.schema ?? {}, 'request', at + '/' + key);
        for (const field of ['style', 'explode', 'allowReserved', 'content']) if (!same(previous[field], parameter[field])) add('review', 'parameter-encoding', at + '/' + key, 'Parameter encoding changed');
      }
      for (const key of oldParams.keys()) if (!nextParams.has(key)) add('review', 'parameter-removed', at + '/' + key, 'Removed parameter may affect server behavior');
      const oldBody = checkedResolve(oldOp.requestBody ?? {}, before, at), nextBody = checkedResolve(nextOp.requestBody ?? {}, after, at);
      if (oldBody && nextBody) {
        if (!oldBody.required && nextBody.required) add('breaking', 'body-required', at, 'Request body became required');
        content(oldBody.content, nextBody.content, 'request', at + '/requestBody');
      }
      for (const [status, oldResponseValue] of Object.entries(oldOp.responses ?? {})) {
        if (!Object.hasOwn(nextOp.responses ?? {}, status)) { add('breaking', 'response-removed', at + '/' + status, 'Response status removed'); continue; }
        const oldResponse = checkedResolve(oldResponseValue, before, at), nextResponse = checkedResolve(nextOp.responses[status], after, at);
        if (oldResponse && nextResponse) {
          content(oldResponse.content, nextResponse.content, 'response', at + '/responses/' + status);
          if (!same(oldResponse.headers, nextResponse.headers)) add('review', 'response-headers', at + '/' + status, 'Response headers changed');
        }
      }
      for (const status of Object.keys(nextOp.responses ?? {})) if (!Object.hasOwn(oldOp.responses ?? {}, status)) add('review', 'response-added', at + '/' + status, 'New response status requires client review');
      for (const field of ['callbacks', 'servers']) if (!same(oldOp[field], nextOp[field])) add('review', 'operation-field', at + '/' + field, `Changed ${field} requires manual review`);
    }
  }
  return { breaking: findings.filter(f => f.severity === 'breaking').length, review: findings.filter(f => f.severity === 'review').length, findings };
}
