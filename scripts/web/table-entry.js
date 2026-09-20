// Vendor entry: headless TanStack Table v9 core for the model list. The
// dashboard drives sorting state and renders its own windowed rows, so the
// bundle exposes the primitives on `window.TanStackTable` instead of a
// framework adapter. Rebuild with `npm run vendor`.
import {
  tableFeatures,
  coreFeatures,
  rowSortingFeature,
  createCoreRowModel,
  createSortedRowModel,
  constructTable,
  sortFns,
  sortFn_basic,
  sortFn_alphanumeric
} from '@tanstack/table-core';
import { storeReactivityBindings } from '@tanstack/table-core/store-reactivity-bindings';

const TanStackTable = {
  tableFeatures,
  coreFeatures,
  rowSortingFeature,
  createCoreRowModel,
  createSortedRowModel,
  constructTable,
  sortFns,
  sortFn_basic,
  sortFn_alphanumeric,
  storeReactivityBindings
};

if (typeof window !== 'undefined') {
  window.TanStackTable = TanStackTable;
}

export default TanStackTable;
