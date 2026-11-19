import type { ComponentChildren } from 'preact';
import type { Tone } from '../format';

const TONES: Record<Tone, string> = {
  neutral: 'bg-zinc-800 text-zinc-300',
  busy: 'bg-sky-500/15 text-sky-300',
  ok: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  error: 'bg-red-500/15 text-red-300',
  muted: 'bg-zinc-800/60 text-zinc-500',
};

export function Badge({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ComponentChildren;
  title?: string;
}) {
  return (
    <span
      title={title}
      class={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[11px] leading-4 font-medium ${TONES[tone]}`}
    >
      {tone === 'busy' && <span class="size-1.5 animate-pulse rounded-full bg-sky-300" />}
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  disabled,
  onChange,
  label,
  hint,
  testId,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      class="group flex w-full items-start gap-3 rounded-md px-1 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        class={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? 'bg-emerald-500' : 'bg-zinc-700 group-hover:bg-zinc-600'
        }`}
      >
        <span
          class={`size-3 rounded-full bg-zinc-950 transition-transform ${checked ? 'translate-x-3' : ''}`}
        />
      </span>
      <span class="min-w-0">
        <span class="block text-zinc-200">{label}</span>
        {hint && <span class="block text-[11px] leading-4 text-zinc-500">{hint}</span>}
      </span>
    </button>
  );
}

export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ComponentChildren;
}) {
  return (
    <section class="space-y-2">
      <h2 class="flex items-baseline gap-2 px-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        {title}
        {count !== undefined && <span class="font-mono font-normal text-zinc-600">{count}</span>}
      </h2>
      {children}
    </section>
  );
}
