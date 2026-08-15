import { DndContext, PointerSensor, TouchSensor, KeyboardSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export type OrderingItem = { id: string; label: string };

function SortableRow({ item, disabled }: { item: OrderingItem; disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? "transform 200ms cubic-bezier(0.32,0.72,0,1)",
    zIndex: isDragging ? 20 : "auto",
    opacity: isDragging ? 0.9 : 1,
    boxShadow: isDragging ? "0 12px 28px rgba(0,0,0,0.5)" : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`w-full p-4 border bg-card text-left flex items-center gap-3 touch-none select-none transition-colors ${isDragging ? "border-volt bg-volt/10" : "border-border hover:border-volt/60"} ${disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
    >
      <span className="font-mono text-xs text-foreground/40 shrink-0">⋮⋮</span>
      <span className="font-medium flex-1">{item.label}</span>
    </div>
  );
}

export function OrderingBoard({
  items, onReorder, disabled,
}: {
  items: OrderingItem[];
  onReorder: (next: OrderingItem[]) => void;
  disabled?: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = items.findIndex((i) => i.id === active.id);
    const newIdx = items.findIndex((i) => i.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    onReorder(arrayMove(items, oldIdx, newIdx));
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy} disabled={disabled}>
        <div className="grid gap-2">
          {items.map((item, i) => (
            <div key={item.id} className="flex items-center gap-2">
              <span className="font-display text-lg italic text-volt w-6 text-right shrink-0">{i + 1}</span>
              <div className="flex-1"><SortableRow item={item} disabled={disabled} /></div>
            </div>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
