/**
 * Значение поля из события.
 *
 * Киты пересылают событие двумя способами: SelectField отдаёт исходное
 * событие DOM, а TextField — обёртку с исходным событием внутри (event.detail).
 * Поэтому значение достаётся из того, что реально пришло, а не из того, что
 * лежит в состоянии компонента: состояние может отставать, если событие
 * «change» пришло без «input».
 */
export function fieldValue(event, fallback = '') {
  const source = event && event.detail && event.detail.target ? event.detail : event;
  const value = source && source.target ? source.target.value : undefined;
  return typeof value === 'string' ? value.trim() : fallback;
}
