export default function SkeletonCard() {
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm overflow-hidden relative">
      <div className="w-16 h-3 bg-warm-gray-light/30 rounded mb-3 skeleton" />
      <div className="w-24 h-6 bg-warm-gray-light/40 rounded skeleton" />
    </div>
  );
}
