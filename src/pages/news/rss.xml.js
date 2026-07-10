import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE } from '../../config';

export async function GET(context) {
  const posts = (await getCollection('news', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
  );

  return rss({
    title: `${SITE.title} News`,
    description: SITE.description,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: `/news/${post.id}/`,
    })),
  });
}
