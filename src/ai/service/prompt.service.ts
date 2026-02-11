import { Injectable } from '@nestjs/common';


// Define the depth types based on our AI_TIER_LIMITS
export type BrandKitDepth = 'BASIC' | 'FULL' | 'STRICT';

@Injectable()
export class PromptBuilder {
  buildSystemPrompt(args: {
    brandKit?: any | null;
    platform?: string;
    toneOverride?: string;
    maxChars?: number;
    depth?: BrandKitDepth;
  }): string {
    const { brandKit, platform, toneOverride, maxChars, depth = 'BASIC' } = args;

    // 1. Core Identity (Creator +)
    const tone = toneOverride ?? brandKit?.tone ?? 'Professional';
    
    // 2. Advanced Identity (Business +)
    // Only include these if the plan allows "FULL" or "STRICT" depth
    const showAdvanced = depth === 'FULL' || depth === 'STRICT';
    
    const voice = showAdvanced ? (brandKit?.brandVoice ?? '') : '';
    const rules = showAdvanced && brandKit?.guidelines ? JSON.stringify(brandKit.guidelines) : '';
    
    // 3. Strict Identity (Rocket only)
    // You could add "Banned Words" or "Must-include Keywords" here
    const strictInstructions = depth === 'STRICT' 
      ? 'STRICT COMPLIANCE: Do not deviate from the voice rules. Ensure high-stakes professional accuracy.' 
      : '';

    const platformRules = this.platformRules(platform, maxChars);

    return [
      'You are Rooli AI, a high-converting social content assistant.',
      'Output MUST be ready-to-post text. No "Sure, here is your post". No explanations.',
      `Target Tone: ${tone}`,
      voice ? `Brand Voice Profile: ${voice}` : '',
      rules ? `Specific Brand Rules (JSON): ${rules}` : '',
      platformRules,
      strictInstructions,
      'If the guidelines contain specific emojis or formatting styles, use them.',
    ]
      .filter(Boolean)
      .join('\n');
  }

buildHolidayAddonPrompt(holidayName: string): string {
  const safeHoliday = holidayName.replace(/\s+/g, ' ').trim();

  return [
    `CONTEXT: The post is for ${safeHoliday}.`,
    'GOAL: Celebrate/acknowledge it in a way that matches the brand and sparks comments.',
    'RULES:',
    `- Avoid generic lines like "Happy ${safeHoliday} to everyone!"`,
    '- Tie the holiday to the brand mission/value (concrete connection).',
    '- Add a clear engagement CTA (a question works best).',
    '- If hashtags are appropriate for the platform, include up to 3 relevant hashtags.',
  ].join('\n');
}

  buildUserPrompt(raw: string): string {
    return `TOPIC/INSTRUCTION: ${raw.trim()}`;
  }

  private platformRules(platform?: string, maxChars?: number): string {
    const limit = maxChars ?? this.defaultCharLimit(platform);
    const base = `STRICT CONSTRAINT: Max ${limit} characters.`;

    switch (platform) {
      case 'X':
      case 'TWITTER':
        return `${base} Style: Punchy, short lines. Separate thread tweets with "\\n---\\n" if needed.`;
      case 'LINKEDIN':
        return `${base} Style: Professional. Use white space (line breaks) between every 1-2 sentences. Avoid more than 3 hashtags.`;
      case 'INSTAGRAM':
        return `${base} Style: Catchy first line (Hook). Emojis encouraged. Place hashtags at the very bottom.`;
      case 'FACEBOOK':
        return `${base} Style: Conversational and community-focused.`;
      default:
        return base;
    }
  }

  private defaultCharLimit(platform?: string): number {
    switch (platform) {
      case 'X':
      case 'TWITTER': return 280;
      case 'LINKEDIN': return 3000; 
      case 'INSTAGRAM': return 2200;
      default: return 2000;
    }
  }
}
