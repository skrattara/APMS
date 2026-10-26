export type AcademicSectionPattern = { programCode: string; yearLevel: number; sectionNumber: number };

function compact(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function institutionalSectionName(section: AcademicSectionPattern, institutionCode = 'SWU') {
  const letter = String.fromCharCode(64 + section.yearLevel);
  return `${institutionCode}-${section.programCode}${section.yearLevel}-${letter}${section.sectionNumber}`;
}

export function resolveInstitutionalSectionName(value: string, sections: AcademicSectionPattern[], institutionCode = 'SWU') {
  const input = compact(value);
  const match = sections.find((section) => {
    const code = compact(section.programCode);
    const letter = String.fromCharCode(64 + section.yearLevel);
    const short = `${letter}${section.sectionNumber}`;
    return input === compact(short)
      || input === compact(`${section.programCode}-${short}`)
      || input === compact(`${section.programCode}-${letter}${section.sectionNumber}`)
      || input === compact(`${section.programCode}${section.yearLevel}-${short}`)
      || input === compact(institutionalSectionName(section, institutionCode))
      || input === compact(`${institutionCode}-${section.programCode}-${short}`)
      || input.endsWith(`${code}${section.yearLevel}${short}`);
  });
  return match ? institutionalSectionName(match, institutionCode) : value;
}
