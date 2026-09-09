/** 名前付きのアサーションを 1 つ実行し、成功も失敗も同じ `{name, pass, detail}`
 * の形へ正規化する。これによりシナリオモジュールは自前の try/catch を一切
 * 持たなくて済む——失敗時は throw された Error のメッセージが `detail` になる。 */
export async function runScenario(name, fn) {
  try {
    const detail = await fn();
    return { name, pass: true, detail: detail ?? 'ok' };
  } catch (err) {
    return { name, pass: false, detail: String(err) };
  }
}
