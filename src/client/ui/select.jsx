// shadcn/ui Select composition, adapted to the plugin's scoped CSS and shared React.
// https://ui.shadcn.com/docs/components/select (MIT; see ui/LICENSE)
import React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { UiIcon } from '../icons/ui-icons.jsx';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = React.forwardRef(function SelectTrigger({ className = '', children, ...props }, ref) {
  return <SelectPrimitive.Trigger ref={ref} className={`cr-select-trigger ${className}`} {...props}>
    {children}
    <SelectPrimitive.Icon asChild><UiIcon name="chevron-down" className="cr-select-chevron" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>;
});

export const SelectContent = React.forwardRef(function SelectContent({ className = '', children, ...props }, ref) {
  return <SelectPrimitive.Portal><SelectPrimitive.Content ref={ref} className={`cr-select-content ${className}`} position="popper" align="start" sideOffset={6} collisionPadding={12} {...props}>
    <SelectPrimitive.ScrollUpButton className="cr-select-scroll"><UiIcon name="chevron-up" /></SelectPrimitive.ScrollUpButton>
    <SelectPrimitive.Viewport className="cr-select-viewport">{children}</SelectPrimitive.Viewport>
    <SelectPrimitive.ScrollDownButton className="cr-select-scroll"><UiIcon name="chevron-down" /></SelectPrimitive.ScrollDownButton>
  </SelectPrimitive.Content></SelectPrimitive.Portal>;
});

export const SelectLabel = React.forwardRef(function SelectLabel({ className = '', ...props }, ref) {
  return <SelectPrimitive.Label ref={ref} className={`cr-select-label ${className}`} {...props} />;
});

export const SelectItem = React.forwardRef(function SelectItem({ className = '', children, ...props }, ref) {
  return <SelectPrimitive.Item ref={ref} className={`cr-select-item ${className}`} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="cr-select-indicator"><UiIcon name="check" size={15} /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
});

export const SelectSeparator = React.forwardRef(function SelectSeparator({ className = '', ...props }, ref) {
  return <SelectPrimitive.Separator ref={ref} className={`cr-select-separator ${className}`} {...props} />;
});
