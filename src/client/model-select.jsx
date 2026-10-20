import React, { useEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from './ui/select.jsx';

const modelValue = (provider, model) => `${provider}\u0000${model}`;

export function ModelSelect({ value, groups = [], disabled, loading, onValueChange, label = '阅读模型', hintId = 'cr-model-hint', fallbackOption = null, missingLabel = '当前会话' }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null); const focusAfterCommit = useRef(false);
  const availableGroups = groups.filter(group => group.models.length);
  const selectedGroup = availableGroups.find(group => group.models.some(model => modelValue(group.id, model.id) === value));
  const selectedModel = selectedGroup?.models.find(model => modelValue(selectedGroup.id, model.id) === value);
  const [provider, model] = value.split('\u0000');
  const usingFallback = !!fallbackOption && value === fallbackOption.value;
  const missingCurrent = !!value && !selectedModel && !usingFallback;
  const empty = !availableGroups.length && !missingCurrent && !fallbackOption;
  // Busy/loading transitions also dismiss an open menu. A commit temporarily disables
  // the trigger, so Radix cannot restore focus until the authoritative refresh finishes.
  useEffect(() => {
    if (disabled) { setOpen(false); return; }
    if (!open && focusAfterCommit.current) {
      focusAfterCommit.current = false;
      if (document.activeElement === document.body || document.activeElement === trigger.current) trigger.current?.focus({ preventScroll: true });
    }
  }, [disabled, open]);

  return <Select value={value} onValueChange={selected => { focusAfterCommit.current = true; onValueChange(selected); }} disabled={disabled || empty} open={open && !disabled && !empty} onOpenChange={setOpen}>
    <SelectTrigger ref={trigger} aria-label={label} aria-describedby={hintId} title={usingFallback ? fallbackOption.label : value ? `${selectedGroup?.name || provider} · ${selectedModel?.name || model}${missingCurrent ? `（${missingLabel}）` : ''}` : undefined}>
      <SelectValue placeholder={loading ? '正在加载模型…' : empty ? '暂无可用模型' : '选择模型'}>
        {usingFallback ? fallbackOption.label : value ? <span className="cr-model-value"><span className="cr-model-provider">{selectedGroup?.name || provider}</span><span className="cr-model-divider" aria-hidden="true">/</span><span className="cr-model-name">{selectedModel?.name || model}</span>{missingCurrent && <span className="cr-model-current">{missingLabel}</span>}</span> : undefined}
      </SelectValue>
    </SelectTrigger>
    <SelectContent aria-label={label} portalContainer={trigger.current?.closest('dialog[open]') ?? undefined}>
      {fallbackOption && <><SelectItem value={fallbackOption.value}>{fallbackOption.label}</SelectItem>{(missingCurrent || availableGroups.length > 0) && <SelectSeparator />}</>}
      {missingCurrent && <><SelectGroup><SelectLabel>{missingLabel}</SelectLabel><SelectItem value={value} textValue={`${provider} ${model}`}><span className="cr-sr-only">{provider} · </span>{model}</SelectItem></SelectGroup>{availableGroups.length > 0 && <SelectSeparator />}</>}
      {availableGroups.map((group, index) => <React.Fragment key={group.id}>
        {index > 0 && <SelectSeparator />}
        <SelectGroup><SelectLabel>{group.name || group.id}</SelectLabel>{group.models.map(item => <SelectItem key={item.id} value={modelValue(group.id, item.id)} textValue={`${item.name || item.id} ${group.name || group.id}`}><span className="cr-sr-only">{group.name || group.id} · </span>{item.name || item.id}</SelectItem>)}</SelectGroup>
      </React.Fragment>)}
    </SelectContent>
  </Select>;
}
