import { memo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Relation, Table } from '../../types';
import { computeRelationGeometry } from '../../lib/canvasLayout';
import type { RelationGeometry } from '../../lib/canvasLayout';

const RELATION_COLOR = '#818cf8';
/** 参照先（PK 側）の矢じりの長さ・半幅。 */
const ARROW_LEN = 9;
const ARROW_HALF = 4.5;

interface PathProps {
  relation: Relation;
  geometry: RelationGeometry;
}

/** 1 本のコネクタ。props はすべて親が算出した値で、`state.tables` を子から引かない:
 * AnimatePresence は退場中の子を最後に渡された props のまま保持するため、テーブル削除と
 * 同時に消えるリレーションでも退場アニメーションの間は端点が保たれる。 */
const RelationPath = memo(function RelationPath({ relation, geometry }: PathProps) {
  const { x1, y1, x2, y2, side2, d } = geometry;
  // 矢じりは参照先の辺に先端を置き、辺の外側（side2 の向き）へ底辺を広げる。
  const arrow = `M ${x2} ${y2} L ${x2 + side2 * ARROW_LEN} ${y2 - ARROW_HALF} L ${x2 + side2 * ARROW_LEN} ${y2 + ARROW_HALF} Z`;
  return (
    <motion.g
      data-testid="relation-connector"
      data-relation-id={relation.id}
      data-from-table={relation.fromTable}
      data-from-column={relation.fromColumn}
      data-to-table={relation.toTable}
      data-to-column={relation.toColumn}
      data-x1={x1}
      data-y1={y1}
      data-x2={x2}
      data-y2={y2}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <motion.path
        d={d}
        fill="none"
        stroke={RELATION_COLOR}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeOpacity={0.85}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        exit={{ pathLength: 0 }}
        transition={{ duration: 0.35, ease: 'easeInOut' }}
      />
      {/* FK 側は丸、参照先（PK 側）は矢じり */}
      <circle cx={x1} cy={y1} r={3.5} fill={RELATION_COLOR} />
      <path d={arrow} fill={RELATION_COLOR} />
    </motion.g>
  );
});

interface Props {
  /** ドラッグ中のライブ位置を反映したテーブル群（Canvas の worldTables） */
  tables: Table[];
  relations: Relation[];
  /** まだ引く順番が来ていない（relation_add の再生待ちの）リレーション id */
  hiddenRelations: Set<string>;
}

/**
 * テーブル間の外部キーのコネクタ層（Issue #45）。Canvas の再レンダーごとに端点を
 * 計算し直すので、テーブルのドラッグ中も `memo` 済みの TableNode を再レンダーせずに線が
 * 追従する。テーブルカードの背面に描かれ、pointer イベントは受けない（パンを妨げない）。
 */
export default function RelationLayer({ tables, relations, hiddenRelations }: Props) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const items: PathProps[] = [];
  for (const relation of relations) {
    if (hiddenRelations.has(relation.id)) continue;
    const from = byName.get(relation.fromTable);
    const to = byName.get(relation.toTable);
    if (!from || !to) continue;
    const geometry = computeRelationGeometry(from, relation.fromColumn, to, relation.toColumn);
    if (geometry) items.push({ relation, geometry });
  }

  return (
    <g data-testid="relation-layer" style={{ pointerEvents: 'none' }}>
      <AnimatePresence>
        {items.map(({ relation, geometry }) => (
          <RelationPath key={relation.id} relation={relation} geometry={geometry} />
        ))}
      </AnimatePresence>
    </g>
  );
}
