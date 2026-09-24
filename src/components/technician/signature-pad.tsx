"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Loader2, PenLine, Type } from "lucide-react";

/**
 * Signature capture for a completed inspection.
 *
 * TWO WAYS TO SIGN
 * The pad is for a finger or a stylus; the typed name is for a desk. A
 * signature is only worth recording if the person could actually produce one,
 * and a technician finishing a job in a plant room with cold hands will not
 * manage a legible stroke on a phone screen. The typed form is not a lesser
 * option — it is the one that will be used most.
 *
 * WHAT IS ACTUALLY STORED
 * The name is always stored. The drawn image is stored only when there is one,
 * as a base64 PNG capped at 200 KB by the API. The name is what identifies the
 * signatory; the image is corroboration, and a report is not invalid without
 * it.
 */

export interface SignatureValue {
  name: string;
  method: "DRAWN" | "TYPED";
  imageDataUrl?: string;
}

/** Backing-store size. Fixed, so the stored image is a predictable size. */
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 160;

export function SignaturePad({
  label,
  busy = false,
  onCancel,
  onSave,
}: {
  label: string;
  busy?: boolean;
  onCancel: () => void;
  onSave: (value: SignatureValue) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasStrokeRef = useRef(false);

  const [name, setName] = useState("");
  const [hasStroke, setHasStroke] = useState(false);

  // Set up the drawing surface once. `touch-action: none` on the canvas is
  // what stops a stroke from scrolling the page instead of drawing.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  const positionOf = useCallback((event: PointerEvent | React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  }, []);

  const start = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;

      event.currentTarget.setPointerCapture(event.pointerId);
      drawingRef.current = true;

      const { x, y } = positionOf(event);
      ctx.beginPath();
      ctx.moveTo(x, y);
    },
    [positionOf]
  );

  const move = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;

      const { x, y } = positionOf(event);
      ctx.lineTo(x, y);
      ctx.stroke();

      if (!hasStrokeRef.current) {
        hasStrokeRef.current = true;
        setHasStroke(true);
      }
    },
    [positionOf]
  );

  const end = useCallback(() => {
    drawingRef.current = false;
  }, []);

  function clear() {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    hasStrokeRef.current = false;
    setHasStroke(false);
  }

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return;

    // A stroke but no name is not a signature, and the API rejects an image
    // without one. Saving here as typed keeps the two consistent.
    if (!hasStroke) {
      onSave({ name: trimmed, method: "TYPED" });
      return;
    }

    const dataUrl = canvasRef.current?.toDataURL("image/png");
    onSave({
      name: trimmed,
      method: "DRAWN",
      ...(dataUrl ? { imageDataUrl: dataUrl } : {}),
    });
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <p className="text-sm font-semibold text-gray-900 dark:text-white">
        {label}
      </p>

      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        aria-label="Signature drawing area"
        className="mt-2 h-32 w-full touch-none rounded border border-gray-300 bg-white"
      />

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
          Clear
        </button>
        <span className="text-xs text-gray-400">
          {hasStroke ? "Drawing captured" : "or type your name below"}
        </span>
      </div>

      <label
        htmlFor={`signature-name-${label.replace(/\s+/g, "-").toLowerCase()}`}
        className="mt-3 block text-xs font-medium text-gray-600 dark:text-gray-400"
      >
        Full name
      </label>
      <div className="relative mt-1">
        <Type
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
          aria-hidden="true"
        />
        <input
          id={`signature-name-${label.replace(/\s+/g, "-").toLowerCase()}`}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Priya Nair"
          autoComplete="name"
          className="w-full rounded-md border border-gray-300 bg-white py-2 pl-8 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-950 dark:text-white dark:focus:ring-blue-900"
        />
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!name.trim() || busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <PenLine className="h-4 w-4" aria-hidden="true" />
          )}
          Save signature
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
