export type Observance = {
  key: string;
  name: string;
  month: number; // 1-12
  day: number;   // 1-31
  color?: string;
  emoji?: string; 
};

export const OBSERVANCES: Observance[] = [
  // --- Q1 (Jan - Mar) ---
  { key: 'NEW_YEAR', name: "New Year's Day", month: 1, day: 1, color: '#10B981', emoji: '🎉' },
  { key: 'BLUE_MONDAY', name: "Blue Monday", month: 1, day: 19, color: '#3B82F6', emoji: '🌧️' }, // Variable, but approx
  { key: 'PIZZA_DAY', name: "National Pizza Day", month: 2, day: 9, color: '#F59E0B', emoji: '🍕' },
  { key: 'VALENTINES', name: "Valentine's Day", month: 2, day: 14, color: '#F43F5E', emoji: '❤️' },
  { key: 'KINDNESS_DAY', name: "Random Acts of Kindness Day", month: 2, day: 17, color: '#EC4899', emoji: '🤗' },
  { key: 'WOMENS_DAY', name: "Intl. Women's Day", month: 3, day: 8, color: '#EC4899', emoji: '👩' },
  { key: 'HAPPINESS_DAY', name: "Intl. Day of Happiness", month: 3, day: 20, color: '#FCD34D', emoji: '😊' },

  // --- Q2 (Apr - Jun) ---
  { key: 'APRIL_FOOLS', name: "April Fool's Day", month: 4, day: 1, color: '#8B5CF6', emoji: '🤡' },
  { key: 'EARTH_DAY', name: "Earth Day", month: 4, day: 22, color: '#10B981', emoji: '🌍' },
  { key: 'STAR_WARS', name: "Star Wars Day", month: 5, day: 4, color: '#1F2937', emoji: '⚔️' },
  { key: 'MENTAL_HEALTH', name: "Mental Health Awareness Month", month: 5, day: 1, color: '#10B981', emoji: '🧠' },
  { key: 'BEST_FRIEND', name: "Best Friends Day", month: 6, day: 8, color: '#EC4899', emoji: '👯' },
  { key: 'YOGA_DAY', name: "Intl. Yoga Day", month: 6, day: 21, color: '#F59E0B', emoji: '🧘' },

  // --- Q3 (Jul - Sep) ---
  { key: 'EMOJI_DAY', name: "World Emoji Day", month: 7, day: 17, color: '#FCD34D', emoji: '📅' },
  { key: 'FRIENDSHIP_DAY', name: "Intl. Friendship Day", month: 7, day: 30, color: '#EC4899', emoji: '🤝' },
  { key: 'BOOK_LOVERS', name: "National Book Lovers Day", month: 8, day: 9, color: '#3B82F6', emoji: '📚' },
  { key: 'PHOTOGRAPHY', name: "World Photography Day", month: 8, day: 19, color: '#6366F1', emoji: '📸' },
  { key: 'PROGRAMMERS', name: "Programmer's Day", month: 9, day: 13, color: '#111827', emoji: '💻' }, // 256th day

  // --- Q4 (Oct - Dec) ---
  { key: 'COFFEE_DAY', name: "Intl. Coffee Day", month: 10, day: 1, color: '#78350F', emoji: '☕' },
  { key: 'MENTAL_HEALTH_DAY', name: "World Mental Health Day", month: 10, day: 10, color: '#10B981', emoji: '💚' },
  { key: 'BOSS_DAY', name: "Boss's Day", month: 10, day: 16, color: '#6B7280', emoji: '👔' },
  { key: 'HALLOWEEN', name: "Halloween", month: 10, day: 31, color: '#F97316', emoji: '🎃' },
  { key: 'MENS_DAY', name: "Intl. Men's Day", month: 11, day: 19, color: '#3B82F6', emoji: '🧔' },
  { key: 'ENTREPRENEURS', name: "Entrepreneurs' Day", month: 11, day: 21, color: '#8B5CF6', emoji: '🚀' },
  { key: 'CHRISTMAS', name: "Christmas Day", month: 12, day: 25, color: '#EF4444', emoji: '🎄' },
  { key: 'NYE', name: "New Year's Eve", month: 12, day: 31, color: '#111827', emoji: '🎆' },
];