import type { TunerAdapter, TunerContext } from "./types.ts";

function tunerPriority(tuner: TunerAdapter): number {
	return tuner.priority ?? 0;
}

export function sortTunerAdapters(tuners: TunerAdapter[]): TunerAdapter[] {
	return [...tuners].sort(
		(left, right) =>
			tunerPriority(left) - tunerPriority(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
	);
}

export async function applyTunerAdapters(
	payload: unknown,
	context: TunerContext,
	tuners: TunerAdapter[],
): Promise<unknown | undefined> {
	let current = payload;
	let changed = false;
	for (const tuner of tuners) {
		try {
			if (!tuner.matches(context, current)) continue;
			const transformed = await tuner.transform(current, context);
			if (transformed !== undefined) {
				current = transformed;
				changed = true;
			}
		} catch (error) {
			console.error(`[${tuner.id}] tuner failed:`, error);
		}
	}
	return changed ? current : undefined;
}
