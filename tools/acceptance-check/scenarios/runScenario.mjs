/** Runs one named assertion, normalizing both success and failure into the
 * same `{name, pass, detail}` shape so scenario modules never need their own
 * try/catch — a thrown Error's message becomes `detail` on failure. */
export async function runScenario(name, fn) {
  try {
    const detail = await fn();
    return { name, pass: true, detail: detail ?? 'ok' };
  } catch (err) {
    return { name, pass: false, detail: String(err) };
  }
}
