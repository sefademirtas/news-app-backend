export interface Topic {
  id: string;
  description: string;
}

export const TOPICS: Topic[] = [
  {
    id: "ai-workplace",
    description: "Latest breakthroughs in productive uses of AI at the workplace",
  },
  {
    id: "ai-psychotherapy",
    description:
      "Latest uses of AI in psychotherapy, whether FDA approved/cleared or not",
  },
];

export const MAX_ARTICLES_PER_TOPIC = 20;
export const ARTICLES_PER_RUN = 5;
