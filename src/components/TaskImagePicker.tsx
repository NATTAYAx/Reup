import { useRef, useState } from "react";
import { ImagePlus, X, Upload } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface Props {
  value: string | null;   // base64 data URL or null
  onChange: (val: string | null) => void;
  category?: string;      // used for fallback gradient colour
}

const CAT_COLORS: Record<string, string> = {
  game:     "from-violet-600 to-indigo-600",
  school:   "from-sky-500 to-cyan-600",
  work:     "from-orange-500 to-red-500",
  personal: "from-emerald-500 to-teal-600",
};

const MAX_SIZE_BYTES = 400 * 1024; // 400 KB after compression

function compressImage(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      let { width, height } = img;
      // Scale down to max 256x256
      const MAX = 256;
      if (width > MAX || height > MAX) {
        const r = Math.min(MAX / width, MAX / height);
        width = Math.round(width * r);
        height = Math.round(height * r);
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);
      // Try quality 0.85 first, then 0.6
      let dataUrl = canvas.toDataURL("image/webp", 0.85);
      if (dataUrl.length > maxBytes * 1.37) {
        dataUrl = canvas.toDataURL("image/webp", 0.6);
      }
      if (dataUrl.length > maxBytes * 1.37) {
        dataUrl = canvas.toDataURL("image/jpeg", 0.5);
      }
      resolve(dataUrl);
    };
    img.onerror = reject;
    img.src = url;
  });
}

export default function TaskImagePicker({ value, onChange, category = "game" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grad = CAT_COLORS[category] ?? CAT_COLORS.game;

  const handleFile = async (file: File) => {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Image files only (PNG, JPG, GIF, WebP)");
      return;
    }
    try {
      const compressed = await compressImage(file, MAX_SIZE_BYTES);
      onChange(compressed);
    } catch {
      setError("Failed to load image — try another file");
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-white/40 text-xs px-1">🖼️ Game image / logo <span className="text-white/20">(optional)</span></label>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={onInputChange}
        className="hidden"
      />

      <AnimatePresence mode="wait">
        {value ? (
          /* Preview mode */
          <motion.div
            key="preview"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="relative flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl p-3 group"
          >
            <div className={`w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-gradient-to-br ${grad} ring-2 ring-white/10`}>
              <img src={value} alt="Task" className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-xs font-semibold">Custom image set</p>
              <p className="text-white/30 text-xs mt-0.5">Shows as task icon</p>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-white/40 hover:text-white transition-all"
                title="Change image"
              >
                <Upload size={13} />
              </button>
              <button
                type="button"
                onClick={() => onChange(null)}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-red-500/20 text-white/40 hover:text-red-400 transition-all"
                title="Remove image"
              >
                <X size={13} />
              </button>
            </div>
          </motion.div>
        ) : (
          /* Upload zone */
          <motion.button
            key="upload"
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`
              w-full flex items-center gap-3 rounded-xl px-4 py-3 border transition-all text-left
              ${dragging
                ? "border-purple-500 bg-purple-500/10"
                : "border-dashed border-white/15 bg-white/3 hover:border-white/30 hover:bg-white/5"
              }
            `}
          >
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br ${grad} opacity-60`}>
              <ImagePlus size={18} className="text-white" />
            </div>
            <div>
              <p className="text-white/50 text-xs font-semibold">
                {dragging ? "Drop to add" : "Add game logo / image"}
              </p>
              <p className="text-white/25 text-xs mt-0.5">PNG · JPG · GIF · WebP · max 400 KB</p>
            </div>
          </motion.button>
        )}
      </AnimatePresence>

      {error && (
        <p className="text-red-400 text-xs px-1">{error}</p>
      )}
    </div>
  );
}