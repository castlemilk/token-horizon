export interface EvaluationContext {
  inputs: Record<string, any>;
  env: Record<string, string | undefined>;
  stages: Record<string, {
    steps: Record<string, {
      outputs: Record<string, any>;
      status: string;
      exitCode?: number;
    }>;
  }>;
}

export class Interpolator {
  /**
   * Resolves nested property path like 'inputs.org' or 'stages.s1.steps.step1.outputs.raw'
   */
  private static getNestedValue(ctx: EvaluationContext, path: string): any {
    const parts = path.trim().split('.');
    let current: any = ctx;

    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }

    return current;
  }

  /**
   * Replaces all {{path.to.variable}} occurrences in a string template.
   */
  public static interpolateString(template: string, ctx: EvaluationContext): string {
    if (!template) return template;

    return template.replace(/\{\{([^}]+)\}\}/g, (_, expression) => {
      const trimmed = expression.trim();
      const val = this.getNestedValue(ctx, trimmed);
      if (val === undefined || val === null) {
        return '';
      }
      if (typeof val === 'object') {
        return JSON.stringify(val);
      }
      return String(val);
    });
  }

  /**
   * Recursively interpolates strings inside objects, arrays, and strings.
   */
  public static interpolateAny(value: any, ctx: EvaluationContext): any {
    if (typeof value === 'string') {
      return this.interpolateString(value, ctx);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.interpolateAny(item, ctx));
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.interpolateAny(v, ctx);
      }
      return result;
    }
    return value;
  }

  /**
   * Evaluates a conditional expression string (e.g. '{{inputs.dry_run}} == false').
   * Returns true if condition evaluates to true or is omitted/empty.
   */
  public static evaluateCondition(condition: string | undefined, ctx: EvaluationContext): boolean {
    if (!condition || condition.trim() === '') return true;

    const interpolated = this.interpolateString(condition, ctx).trim();

    // Simple comparisons: ==, !=, truthy
    if (interpolated.includes('==')) {
      const [left, right] = interpolated.split('==').map((s) => s.trim());
      return left === right || (left.toLowerCase() === 'true' && right.toLowerCase() === 'true');
    }
    if (interpolated.includes('!=')) {
      const [left, right] = interpolated.split('!=').map((s) => s.trim());
      return left !== right;
    }

    // Direct boolean checks
    if (interpolated.toLowerCase() === 'true') return true;
    if (interpolated.toLowerCase() === 'false') return false;
    if (interpolated === '0' || interpolated === '') return false;

    return Boolean(interpolated);
  }
}
