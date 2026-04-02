/**
 * Seed database with 200 hardcoded quotes (enough to test pipeline).
 * No API key needed. Run full seed-quotes.js later with real key for 2000+.
 */
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";

const DB_PATH = process.env.DB_PATH || "./data/content.db";

if (!existsSync("./data")) mkdirSync("./data", { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS quotes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT    NOT NULL UNIQUE,
    author      TEXT    DEFAULT 'Original',
    category    TEXT    NOT NULL,
    hash        TEXT    NOT NULL UNIQUE,
    used_count  INTEGER DEFAULT 0,
    last_used_at TEXT,
    created_at  TEXT    DEFAULT (datetime('now')),
    source      TEXT    DEFAULT 'seed'
  );
  CREATE INDEX IF NOT EXISTS idx_quotes_category ON quotes(category);
  CREATE INDEX IF NOT EXISTS idx_quotes_unused ON quotes(used_count, last_used_at);
`);

const QUOTES = {
  "success and ambition": [
    "The distance between where you are and where you want to be is measured in uncomfortable actions.",
    "Ambition without execution is just expensive daydreaming.",
    "Success isn't about the destination — it's about who you become refusing to quit.",
    "The world doesn't reward the talented. It rewards the relentless.",
    "Your ceiling is someone else's floor. Keep climbing.",
    "Every empire was built by someone who was told it couldn't be done.",
    "Comfort is the graveyard where ambition goes to die quietly.",
    "The gap between dreaming and doing is called discipline.",
    "Success leaves clues, but only if you're paying attention.",
    "The best time to start was yesterday. The next best time is right now.",
    "Small daily improvements are the key to staggering long-term results.",
    "Don't tell people your plans. Show them your results.",
    "Winners focus on winning. Losers focus on winners.",
    "The harder you work in silence, the louder your success speaks.",
    "Successful people do what unsuccessful people are unwilling to do.",
    "Your future is created by what you do today, not tomorrow.",
    "It's not about being the best. It's about being better than you were yesterday.",
    "Opportunities don't happen. You create them.",
    "The only impossible journey is the one you never begin.",
    "Great things never come from comfort zones.",
  ],
  "discipline and daily habits": [
    "Motivation gets you started. Systems keep you going when motivation leaves.",
    "You don't rise to the level of your goals. You fall to the level of your habits.",
    "The person you'll be in five years is defined by what you do in the next five minutes.",
    "Discipline is choosing between what you want now and what you want most.",
    "Every morning you have two choices: continue to sleep with your dreams, or wake up and chase them.",
    "Small disciplines repeated daily create massive results over time.",
    "The chains of habit are too light to be felt until they're too heavy to be broken.",
    "Success is nothing more than a few simple disciplines practiced every day.",
    "Your daily routine is the foundation your entire life is built upon.",
    "Consistency beats intensity. What you do every day matters more than what you do once in a while.",
    "The secret of your future is hidden in your daily routine.",
    "Discipline is the bridge between goals and accomplishment.",
    "What you repeatedly do forms who you permanently become.",
    "Habits are the compound interest of self-improvement.",
    "You will never change your life until you change something you do daily.",
    "The price of discipline is always less than the pain of regret.",
    "Your habits decide your future. Choose them wisely.",
    "Excellence is not an act but a habit built through daily repetition.",
    "Most people overestimate what they can do in a day and underestimate what they can do in a year.",
    "Routine is not the enemy of creativity — it's the foundation of it.",
  ],
  "mental strength and resilience": [
    "A calm mind is the ultimate weapon against every challenge life throws at you.",
    "You don't become strong by winning. You become strong by surviving what nearly broke you.",
    "The strongest people aren't those who show strength — they're those who win battles others know nothing about.",
    "Mental toughness isn't about never falling. It's about getting up every single time.",
    "Your mind is a garden. You can grow flowers or you can grow weeds.",
    "Strength doesn't come from what you can do. It comes from overcoming the things you thought you couldn't.",
    "The mind that opens to a new idea never returns to its original size.",
    "Pain is temporary. Quitting is permanent.",
    "Rock bottom became the solid foundation on which I rebuilt everything.",
    "The obstacle is the way. What stands in your path becomes your path.",
    "Tough times never last, but tough people do.",
    "You are stronger than you think and braver than you feel.",
    "Every adversity carries with it the seed of an equivalent advantage.",
    "The oak fought the wind and was broken. The willow bent and survived.",
    "Pressure either bursts pipes or creates diamonds. Your mindset decides which.",
    "What doesn't challenge you doesn't change you.",
    "A warrior's greatest weapon is an unshakeable mind.",
    "Storms don't last forever. Neither does pain. Hold on.",
    "The human spirit is stronger than anything that can happen to it.",
    "Fear kills more dreams than failure ever will.",
  ],
  "overcoming failure and setbacks": [
    "Failure is not the opposite of success — it's a required stop on the way there.",
    "Every expert was once a beginner who refused to give up.",
    "The only real failure is the failure to try.",
    "Fall seven times, stand up eight. That's what champions do.",
    "Your setback is just a setup for a comeback.",
    "Mistakes are proof that you are trying.",
    "The master has failed more times than the beginner has tried.",
    "Don't let a bad chapter convince you it's the end of your story.",
    "Failure is simply the opportunity to begin again, this time more intelligently.",
    "The comeback is always stronger than the setback.",
    "You haven't failed until you've stopped trying.",
    "Every failure brings you one step closer to the approach that works.",
    "Scars are just proof that you were stronger than whatever tried to hurt you.",
    "Success is stumbling from failure to failure without losing enthusiasm.",
    "The only way to guarantee failure is to never attempt anything at all.",
    "A smooth sea never made a skilled sailor.",
    "Rejection is redirection to something better.",
    "Your worst days are never so bad that you are beyond the reach of hope.",
    "Sometimes you win, sometimes you learn. But you never truly lose.",
    "The phoenix must burn to emerge. So must you.",
  ],
  "self-improvement and growth mindset": [
    "Invest in yourself. It's the one investment that always pays dividends.",
    "Growth begins where your comfort zone ends.",
    "The best project you'll ever work on is yourself.",
    "Learning is not a destination. It's a lifestyle.",
    "You can't pour from an empty cup. Fill yourself first.",
    "Progress is progress, no matter how small the step.",
    "Who you are is not who you have to remain.",
    "The man who reads lives a thousand lives. The man who doesn't lives only one.",
    "Your potential is limited only by the effort you refuse to give.",
    "Don't compare your chapter one to someone else's chapter twenty.",
    "Growth is painful. Change is painful. But nothing is as painful as staying stuck.",
    "Become the person who would attract the results you seek.",
    "The only person you should try to be better than is the person you were yesterday.",
    "Self-education is the most powerful investment you'll ever make.",
    "You are under no obligation to be the same person you were five minutes ago.",
    "Growth demands a temporary surrender of security.",
    "Every skill you acquire doubles your odds of success.",
    "The biggest room in the world is the room for improvement.",
    "Be a student long after you leave the classroom.",
    "Your life does not get better by chance. It gets better by change.",
  ],
  "stoic philosophy and inner peace": [
    "You have power over your mind, not outside events. Realize this, and you find strength.",
    "The obstacle on the path becomes the path. Never forget that.",
    "Peace is not the absence of storms — it's the calm within them.",
    "Stop trying to control what you can't. Master what you can.",
    "The wise man is not disturbed by what happens, only by his reaction to it.",
    "Tranquility comes from accepting the things you cannot change.",
    "The universe doesn't give you what you ask for. It gives you what you prepare for.",
    "He who controls his emotions controls the battlefield.",
    "Silence is sometimes the best answer to a world that demands reaction.",
    "The root of suffering is attachment to outcomes.",
    "What you own ends up owning you. Travel light.",
    "No person is free who is not master of themselves.",
    "The mind adapted to adversity is the mind prepared for anything.",
    "Don't explain your philosophy. Embody it.",
    "Everything we hear is an opinion, not a fact. Everything we see is perspective, not truth.",
    "It's not what happens to you, but how you respond that defines your character.",
    "Waste no time arguing what a good person should be. Be one.",
    "The impediment to action advances action. What stands in the way becomes the way.",
    "True wealth is wanting nothing.",
    "Master your thoughts, or they will master you.",
  ],
  "wealth mindset and financial freedom": [
    "Rich people acquire assets. The poor and middle class acquire liabilities they think are assets.",
    "Financial freedom isn't about having more money. It's about having more choices.",
    "Don't work for money. Make money work for you.",
    "Wealth is not about having a lot of money. It's about having a lot of options.",
    "The greatest investment you can make is in your own ability to earn.",
    "Money is a tool. Used wisely, it buys freedom. Used poorly, it buys chains.",
    "Your income can only grow to the extent that you do.",
    "Financial literacy is not an option. It's a survival skill.",
    "Poor people have big TVs. Rich people have big libraries.",
    "The rich invest in time. The poor invest in money.",
    "If you don't find a way to make money while you sleep, you will work until you die.",
    "Broke is temporary. Poor is a mindset.",
    "Building wealth is a marathon, not a sprint. Patience is the strategy.",
    "Every dollar you save is a soldier fighting for your future freedom.",
    "The fastest way to double your money is to fold it and put it back in your pocket.",
    "Spend less than you earn. Invest the difference. Avoid debt. Be patient.",
    "Your network determines your net worth.",
    "Money follows those who learn to manage it, not those who chase it.",
    "Financial freedom is available to those who learn about it and work for it.",
    "Wealth isn't about consumption. It's about contribution and compound growth.",
  ],
  "leadership and influence": [
    "A leader is someone who demonstrates what's possible, not what's comfortable.",
    "The best leaders don't create followers. They create more leaders.",
    "Lead by example. There is no other way.",
    "True leadership is about making others better as a result of your presence.",
    "People don't follow titles. They follow courage.",
    "A good leader takes a little more than their share of the blame and a little less than their share of credit.",
    "Leadership is not about being in charge. It's about taking care of those in your charge.",
    "The quality of a leader is reflected in the standards they set for themselves.",
    "Great leaders don't set out to be a leader. They set out to make a difference.",
    "Influence is built through consistent action, not occasional speeches.",
    "The task of leadership is not to put greatness into people, but to elicit it.",
    "A leader's silence speaks louder than their words.",
    "You don't need a title to be a leader. You need a spine.",
    "Leadership is the capacity to translate vision into reality.",
    "The greatest leader is not the one who does the greatest things, but the one who gets people to do the greatest things.",
    "Lead from the front when things are hard. Lead from behind when things are going well.",
    "Your team doesn't care how much you know until they know how much you care.",
    "Vision without execution is hallucination.",
    "Real leaders are ordinary people with extraordinary determination.",
    "The measure of a leader is not the number of people who serve them, but the number of people they serve.",
  ],
  "time management and productivity": [
    "Time is the only currency you can never earn back. Spend it wisely.",
    "Focus is saying no to a hundred good ideas so you can say yes to the great one.",
    "It's not about having time. It's about making time for what matters.",
    "The bad news is time flies. The good news is you're the pilot.",
    "Productivity is never an accident. It's always the result of commitment to excellence.",
    "Don't confuse being busy with being productive. They are rarely the same thing.",
    "If it takes less than two minutes, do it now. Procrastination is the enemy.",
    "Work expands to fill the time available. Set tighter deadlines.",
    "One hour of focused work is worth four hours of distracted effort.",
    "The key to productivity is not time management. It's energy management.",
    "Your most valuable asset is not your time — it's your attention.",
    "Action expresses priorities. If it matters, you'll find the time.",
    "Efficiency is doing things right. Effectiveness is doing the right things.",
    "Stop managing your time. Start managing your focus.",
    "The art of productivity is eliminating the unnecessary so the necessary can speak.",
    "Multitasking is the art of doing twice as much half as well.",
    "Plan your day or someone else will plan it for you.",
    "The two most powerful warriors are patience and time.",
    "Tomorrow's success is determined by today's choices.",
    "Time wasted is existence. Time used is life.",
  ],
  "emotional intelligence and relationships": [
    "The strongest people are not those who always win, but those who stay kind after losing.",
    "Your words have the power to build someone up or tear them down. Choose wisely.",
    "Listening is the most underrated form of intelligence.",
    "People won't remember what you said. They'll remember how you made them feel.",
    "Empathy is seeing with the eyes of another, listening with the ears of another, and feeling with the heart of another.",
    "The art of communication is not about being heard. It's about understanding.",
    "Emotional intelligence begins the moment you step outside your own perspective.",
    "The quality of your life is the quality of your relationships.",
    "Be kind. Everyone you meet is fighting a battle you know nothing about.",
    "Anger is an acid that does more harm to the vessel in which it's stored than to the thing on which it's poured.",
    "Strong people don't put others down. They lift them up.",
    "Understanding someone's struggle doesn't mean you've felt their pain.",
    "The greatest gift you can give someone is your genuine attention.",
    "Before you speak, let your words pass through three gates: Is it true? Is it kind? Is it necessary?",
    "Connection is why we're here. It gives purpose and meaning to our lives.",
    "How people treat others is a direct reflection of how they feel about themselves.",
    "Wisdom is knowing when to speak and when to simply be present.",
    "Trust is built in drops and lost in buckets.",
    "The most important conversations happen when you stop talking and start listening.",
    "True strength is being soft in a world that constantly demands hardness.",
  ],
};

const insert = db.prepare(
  "INSERT OR IGNORE INTO quotes (text, author, category, hash, source) VALUES (?, 'Original', ?, ?, 'static-seed')"
);

function hash(text) {
  return createHash("sha256").update(text.toLowerCase().trim()).digest("hex").slice(0, 16);
}

let total = 0;
const tx = db.transaction(() => {
  for (const [category, quotes] of Object.entries(QUOTES)) {
    for (const text of quotes) {
      const result = insert.run(text, category, hash(text));
      if (result.changes > 0) total++;
    }
  }
});
tx();

const count = db.prepare("SELECT COUNT(*) as c FROM quotes").get().c;
const cats = db.prepare("SELECT category, COUNT(*) as c FROM quotes GROUP BY category ORDER BY category").all();

console.log(`\n=== Static Seed Complete ===`);
console.log(`Inserted: ${total} new quotes`);
console.log(`Total in DB: ${count}\n`);
for (const c of cats) console.log(`  ${c.category}: ${c.c}`);
console.log(`\nRun 'node scripts/seed-quotes.js' later with ANTHROPIC_API_KEY for 2000+ quotes.`);

db.close();
