const typeColor: Record<string, string> = {
  INT: '#3b82f6',
  VARCHAR: '#10b981',
  TEXT: '#10b981',
  BOOLEAN: '#f59e0b',
  DATE: '#8b5cf6',
  UNKNOWN: '#64748b',
};

export function getColumnTypeColor(type: string): string {
  return typeColor[type] ?? '#64748b';
}
