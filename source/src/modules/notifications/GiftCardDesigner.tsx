// Settings › Templates › Gift voucher: the card a voucher bought online is
// printed on. The coach uploads their artwork and drags the recipient's name,
// the code and the value to where they belong on it; the send path writes each
// voucher's own onto the same spots (_shared/gift-card-pdf.mts).
//
// The preview is HTML over the picture, sized in container units so it scales
// with the picture the way the PDF does. "Preview PDF" builds the real thing
// with the same function the email uses, for the last word on how it prints.
//
// Presentational like MessageTemplatesPanel: it is handed the design and
// reports changes, and App.tsx saves them with the rest of Templates.

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, FileText, ImagePlus, Trash2 } from "lucide-react";
import {
  GIFT_CARD_FIELDS,
  GIFT_CARD_MAX_SIZE,
  GIFT_CARD_MIN_SIZE,
  type GiftCardAlign,
  type GiftCardDesign,
  type GiftCardField,
  type GiftCardFieldId,
  type GiftCardFont,
} from "../../../netlify/functions/_shared/gift-card.mts";
import { formatMoney } from "../../lib/money";
import { t } from "../../lib/i18n";
import { prepareImage } from "../site-builder/imagePrep";
import { uploadSiteImage } from "../site-builder/siteApi";

const FONT_FAMILY: Record<GiftCardFont, string> = {
  sans: "Helvetica, Arial, sans-serif",
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};

const SHIFT: Record<GiftCardAlign, string> = { left: "0%", center: "-50%", right: "-100%" };

function fieldLabel(id: GiftCardFieldId) {
  if (id === "name") return t("Name");
  if (id === "item") return t("What it's for");
  if (id === "code") return t("Code");
  return t("Value");
}

function sampleText(id: GiftCardFieldId) {
  if (id === "name") return t("Recipient name");
  // Printed only on a voucher for a lesson or product.
  if (id === "item") return t("1 hour lesson");
  if (id === "code") return "CG-7KQ4-M2XP";
  return formatMoney(100);
}

const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;

export type GiftCardDesignerProps = {
  design: GiftCardDesign;
  /** Read-only until Templates is put into edit mode. */
  locked: boolean;
  onChange: (design: GiftCardDesign) => void;
};

export function GiftCardDesigner({ design, locked, onChange }: GiftCardDesignerProps) {
  const [selected, setSelected] = useState<GiftCardFieldId>("name");
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: GiftCardFieldId; startX: number; startY: number; fieldX: number; fieldY: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const field = design.fields[selected];

  function setField(id: GiftCardFieldId, patch: Partial<GiftCardField>) {
    onChange({ ...design, fields: { ...design.fields, [id]: { ...design.fields[id], ...patch } } });
  }

  async function upload(file: File | undefined) {
    if (!file || locked) return;
    setUploading(true);
    setError("");
    try {
      // JPEG or PNG: the PDF the card goes out as takes nothing else.
      const prepared = await prepareImage(file, { printable: true });
      onChange({ ...design, imageUrl: await uploadSiteImage(prepared.type, prepared.dataBase64) });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message !== "unreadable" && cause.message !== "not-an-image"
          ? cause.message
          : t("Could not read that picture. Try a JPG or PNG."),
      );
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function previewPdf() {
    if (!design.imageUrl) return;
    setPreviewing(true);
    setError("");
    try {
      const [{ buildGiftCardPdf }, response] = await Promise.all([
        import("../../../netlify/functions/_shared/gift-card-pdf.mts"),
        fetch(design.imageUrl),
      ]);
      if (!response.ok) throw new Error("unreadable");
      const pdf = await buildGiftCardPdf(design, new Uint8Array(await response.arrayBuffer()), [
        { name: sampleText("name"), item: sampleText("item"), code: sampleText("code"), value: sampleText("value") },
      ]);
      const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.download = "gift-voucher-preview.pdf";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError(t("Could not make the preview. Try uploading the picture again."));
    } finally {
      setPreviewing(false);
    }
  }

  function startDrag(id: GiftCardFieldId, event: PointerEvent<HTMLButtonElement>) {
    setSelected(id);
    if (locked) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, startX: event.clientX, startY: event.clientY, fieldX: design.fields[id].x, fieldY: design.fields[id].y };
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    const rect = stage.current?.getBoundingClientRect();
    if (!active || !rect?.width || !rect.height) return;
    setField(active.id, {
      x: round(active.fieldX + (event.clientX - active.startX) / rect.width),
      y: round(active.fieldY + (event.clientY - active.startY) / rect.height),
    });
  }

  function nudge(id: GiftCardFieldId, event: KeyboardEvent<HTMLButtonElement>) {
    if (locked) return;
    const step = event.shiftKey ? 0.02 : 0.005;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setField(id, { x: round(design.fields[id].x + move[0]), y: round(design.fields[id].y + move[1]) });
  }

  return (
    <section className="gift-card-designer" aria-label={t("Gift card")}>
      <div className="gcd-head">
        <div>
          <strong>{t("Gift card")}</strong>
          <p>
            {design.imageUrl
              ? t("Drag each field to where it goes on your artwork. Each voucher sold gets its own card, attached to this email as a PDF. What it's for prints only on vouchers for a lesson or product, and the value only where the voucher shows it.")
              : t("Upload your voucher artwork and every voucher sold online gets its own card, with the name and code printed on, attached to this email as a PDF.")}
          </p>
        </div>
        <div className="gcd-actions">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button className="outline-button" type="button" disabled={locked || uploading} onClick={() => fileInput.current?.click()}>
            <ImagePlus size={15} />
            {uploading ? t("Uploading…") : design.imageUrl ? t("Replace picture") : t("Upload picture")}
          </button>
          {design.imageUrl && (
            <>
              <button className="outline-button" type="button" disabled={previewing} onClick={() => void previewPdf()}>
                <FileText size={15} />
                {t("Preview PDF")}
              </button>
              <button className="text-button" type="button" disabled={locked} onClick={() => onChange({ ...design, imageUrl: "" })}>
                <Trash2 size={14} />
                {t("Remove")}
              </button>
            </>
          )}
        </div>
      </div>
      {error && <p className="gcd-error">{error}</p>}

      {design.imageUrl && (
        <div className="gcd-body">
          <div className="gcd-stage" ref={stage}>
            <img src={design.imageUrl} alt="" draggable={false} />
            {GIFT_CARD_FIELDS.map((id) => {
              const entry = design.fields[id];
              if (!entry.show) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className={`gcd-field${selected === id ? " is-selected" : ""}`}
                  style={{
                    left: `${entry.x * 100}%`,
                    top: `${entry.y * 100}%`,
                    // A line-height: 1 box centred on y puts the baseline
                    // about GIFT_CARD_BASELINE_DROP of the size below y, which
                    // is where the PDF draws it.
                    transform: `translate(${SHIFT[entry.align]}, -50%)`,
                    fontSize: `${entry.size * 100}cqw`,
                    fontFamily: FONT_FAMILY[entry.font],
                    fontWeight: entry.bold ? 700 : 400,
                    color: entry.color,
                  }}
                  aria-label={t("Move the {field}", { field: fieldLabel(id).toLowerCase() })}
                  onPointerDown={(event) => startDrag(id, event)}
                  onPointerMove={moveDrag}
                  onPointerUp={() => (drag.current = null)}
                  onPointerCancel={() => (drag.current = null)}
                  onKeyDown={(event) => nudge(id, event)}
                  onFocus={() => setSelected(id)}
                >
                  {sampleText(id)}
                </button>
              );
            })}
          </div>

          <div className="gcd-controls">
            <div className="gcd-tabs" role="tablist" aria-label={t("What is printed on the card")}>
              {GIFT_CARD_FIELDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={selected === id}
                  className={selected === id ? "is-active" : ""}
                  onClick={() => setSelected(id)}
                >
                  {fieldLabel(id)}
                </button>
              ))}
            </div>
            <label className="gcd-check">
              <input
                type="checkbox"
                checked={field.show}
                disabled={locked}
                onChange={(event) => setField(selected, { show: event.target.checked })}
              />
              {t("Print it on the card")}
            </label>
            <label className="gcd-row">
              <span>{t("Size")}</span>
              <input
                type="range"
                min={GIFT_CARD_MIN_SIZE}
                max={GIFT_CARD_MAX_SIZE}
                step={0.001}
                value={field.size}
                disabled={locked || !field.show}
                onChange={(event) => setField(selected, { size: Number(event.target.value) })}
              />
            </label>
            <div className="gcd-row">
              <span>{t("Style")}</span>
              <select
                value={field.font}
                aria-label={t("Font")}
                disabled={locked || !field.show}
                onChange={(event) => setField(selected, { font: event.target.value as GiftCardFont })}
              >
                <option value="sans">{t("Sans serif")}</option>
                <option value="serif">{t("Serif")}</option>
                <option value="mono">{t("Typewriter")}</option>
              </select>
              <button
                type="button"
                className={`gcd-icon${field.bold ? " is-active" : ""}`}
                aria-pressed={field.bold}
                aria-label={t("Bold")}
                disabled={locked || !field.show}
                onClick={() => setField(selected, { bold: !field.bold })}
              >
                <Bold size={15} />
              </button>
              <input
                type="color"
                value={field.color}
                aria-label={t("Colour")}
                disabled={locked || !field.show}
                onChange={(event) => setField(selected, { color: event.target.value })}
              />
            </div>
            <div className="gcd-row" role="group" aria-label={t("Line up")}>
              <span>{t("Line up")}</span>
              {(
                [
                  ["left", AlignLeft, t("From the left")],
                  ["center", AlignCenter, t("Centred")],
                  ["right", AlignRight, t("From the right")],
                ] as const
              ).map(([align, Icon, label]) => (
                <button
                  key={align}
                  type="button"
                  className={`gcd-icon${field.align === align ? " is-active" : ""}`}
                  aria-pressed={field.align === align}
                  aria-label={label}
                  title={label}
                  disabled={locked || !field.show}
                  onClick={() => setField(selected, { align })}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
            <p className="gcd-note">{t("A long name shrinks to fit the card. Use the arrow keys to nudge a selected field.")}</p>
          </div>
        </div>
      )}
    </section>
  );
}
