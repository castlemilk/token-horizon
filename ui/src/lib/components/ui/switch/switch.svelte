<script lang="ts">
	import { Switch as SwitchPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<SwitchPrimitive.RootProps> = $props();
</script>

<SwitchPrimitive.Root
	bind:ref
	bind:checked
	data-slot="switch"
	class={cn(
		"peer inline-flex h-[31px] w-[51px] shrink-0 cursor-pointer items-center rounded-full border border-transparent px-[3px] shadow-xs transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--ok)] data-[state=unchecked]:bg-[var(--track)]",
		className
	)}
	{...restProps}
>
	<SwitchPrimitive.Thumb
		data-slot="switch-thumb"
		class={cn(
			"pointer-events-none block size-[25px] rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.35)] ring-0 transition-transform duration-150 data-[state=checked]:translate-x-[20px] data-[state=unchecked]:translate-x-0"
		)}
	/>
</SwitchPrimitive.Root>
