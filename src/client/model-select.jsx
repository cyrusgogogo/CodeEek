import React, { useEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from './ui/select.jsx';

const modelValue = (provider, model) => `${provider}\u0000${model}`;

export function ModelSelect({ value, groups = [], disabled, loading, onValueChange }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null); const focusAfterCommit = useRef(false);
  const availableGroups = groups.filter(group => group.models.length);
  const selectedGroup = availableGroups.find(group => group.models.some(model => modelValue(group.id, model.id) === value));
  const selectedModel = selectedGroup?.models.find(model => modelValue(selectedGroup.id, model.id) === value);
  const [provider, model] = value.split('\u0000');
  const missingCurrent = !!value && !selectedModel;
  const empty = !availableGroups.length && !missingCurrent;
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
    <SelectTrigger ref={trigger} aria-label="阅读模型" aria-describedby="cr-model-hint" title={value ? `${selectedGroup?.name || provider} · ${selectedModel?.name || model}${missingCurrent ? '（当前会话）' : ''}` : undefined}>
      <SelectValue placeholder={loading ? '正在加载模型…' : empty ? '暂无可用模型' : '选择模型'}>
        {value ? <span className="cr-model-value"><span className="cr-model-provider">{selectedGroup?.name || provider}</span><span className="cr-model-divider" aria-hidden="true">/</span><span className="cr-model-name">{selectedModel?.name || model}</span>{missingCurrent && <span className="cr-model-current">当前会话</span>}</span> : undefined}
      </SelectValue>
    </SelectTrigger>
    <SelectContent aria-label="阅读模型">
      {missingCurrent && <><SelectGroup><SelectLabel>当前会话</SelectLabel><SelectItem value={value} textValue={`${provider} ${model}`}><span className="cr-sr-only">{provider} · </span>{model}</SelectItem></SelectGroup>{availableGroups.length > 0 && <SelectSeparator />}</>}
      {availableGroups.map((group, index) => <React.Fragment key={group.id}>
        {index > 0 && <SelectSeparator />}
        <SelectGroup><SelectLabel>{group.name || group.id}</SelectLabel>{group.models.map(item => <SelectItem key={item.id} value={modelValue(group.id, item.id)} textValue={`${item.name || item.id} ${group.name || group.id}`}><span className="cr-sr-only">{group.name || group.id} · </span>{item.name || item.id}</SelectItem>)}</SelectGroup>
      </React.Fragment>)}
    </SelectContent>
  </Select>;
}
