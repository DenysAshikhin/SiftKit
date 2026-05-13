export class RepoSearchOutputFormatter {
  public static formatFinalOutputs(values: string[]): string {
    const formattedOutputs: string[] = [];
    for (const value of values) {
      const formatted = RepoSearchOutputFormatter.collapseRepeatedWholeOutput(value);
      if (formatted && !formattedOutputs.includes(formatted)) {
        formattedOutputs.push(formatted);
      }
    }
    return formattedOutputs.join('\n\n');
  }

  public static collapseRepeatedWholeOutput(value: string): string {
    const text = value.trim();
    if (!text) {
      return '';
    }

    const lines = text.split(/\r?\n/u);
    if (lines.length < 6 || text.length < 120) {
      return text;
    }

    for (let boundary = 1; boundary < lines.length; boundary += 1) {
      const left = lines.slice(0, boundary).join('\n').trim();
      const right = lines.slice(boundary).join('\n').trim();
      if (left.length >= 60 && left === right) {
        return left;
      }
    }

    return text;
  }
}
