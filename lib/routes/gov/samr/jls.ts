import { Route } from '@/types';
import got from '@/utils/got';
import { load } from 'cheerio';
import { parseDate } from '@/utils/parse-date';

const rootUrl = 'https://www.samr.gov.cn';
const currentUrl = new URL('jls/', rootUrl).href;

const types = {
    legal: 'fzjl', // 法制计量
    science: 'kxjl', // 科学计量
};

export const route: Route = {
    path: '/samr/jls/:type?',
    categories: ['government'],
    example: '/gov/samr/jls/legal',
    parameters: {
        type: {
            description: '计量类型',
            default: 'legal',
            options: [
                { value: 'legal', label: '法制计量' },
                { value: 'science', label: '科学计量' },
            ],
        },
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['www.samr.gov.cn/jls/'],
        },
    ],
    name: '国家市场监督管理总局计量司',
    maintainers: ['nczitzk'],
    handler,
    url: 'www.samr.gov.cn/jls/',
    description: '国家市场监督管理总局计量司相关信息',
};

async function handler(ctx) {
    const { type = 'legal' } = ctx.req.param();
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit'), 10) : 10;

    // 构建具体类型的URL
    const typeUrl = new URL(`${types[type]}/`, currentUrl).href;

    // 获取页面内容
    const { data: response } = await got(typeUrl);
    const $ = load(response);
    // 提取列表项
    let items = [];

    // 根据不同类型使用不同的选择器
    if (type === 'legal') {
        // 从HTML结构看，每个文章项由两个li组成，一个包含标题，一个包含日期
        // 获取所有标题li元素
        const titleElements = $('.gts_contentLeftList01');

        items = [];

        // 遍历标题元素，同时获取对应的日期元素
        for (let i = 0; i < titleElements.length && i < limit; i++) {
            const titleLi = $(titleElements[i]);
            // 下一个兄弟元素通常是日期元素
            const dateLi = titleLi.next('.gts_contentLeftList01time');

            const a = titleLi.find('a');
            const title = a.text().trim();
            // 处理相对和绝对链接
            const href = a.attr('href');
            const link = href.startsWith('http') ? href : new URL(href, rootUrl).href;
            const date = dateLi.text().trim();

            items.push({
                title,
                link,
                pubDate: parseDate(date),
                guid: link,
            });
        }
    } else if (type === 'science') {
        // 查找所有标题元素
        const titleItems = $('.gts_contentLeftList01').slice(0, limit);

        items = titleItems.toArray().map((_, titleItem) => {
            titleItem = $(titleItem);
            const a = titleItem.find('a');
            const title = a.text().trim();
            let link = a.attr('href');

            // 处理链接，确保是绝对链接
            if (link) {
                // 检查是否已经是完整URL，如果不是则构建完整URL
                link = link.startsWith('http') ? link : new URL(link, rootUrl).href;
            }

            // 查找对应的日期元素（在同一个ul下的下一个li）
            const dateItem = titleItem.parent().find('.gts_contentLeftList01time');
            const date = dateItem.text().trim();

            return {
                title,
                link,
                pubDate: parseDate(date),
                guid: link,
            };
        });
    }

    // 获取文章详情
    items = await Promise.all(
        items.map(async (item) => {
            try {
                const { data: detailResponse } = await got(item.link);
                const detail$ = load(detailResponse);

                // 提取正文内容，尝试多种可能的选择器
                let content = '';

                // 尝试多种可能的正文容器选择器
                const contentSelectors = [
                    '#con_con', // 主要正文容器
                    '.content', // 常见内容类
                    '.mainContent', // 主内容区
                    '.article_content', // 文章内容
                    '.TRS_Editor', // 常见政府网站编辑器内容
                    '.TRS_Editor_QQPUB', // 腾讯编辑器
                    '#zoom', // 常见新闻放大容器
                    '.infoContent', // 信息内容
                    '.gts_contentBox', // 根据页面结构推测的内容容器
                    '.gts_contentLeftBox', // 左侧内容区
                ];

                for (const selector of contentSelectors) {
                    const foundContent = detail$(selector).html();
                    if (foundContent) {
                        content = foundContent;
                        break;
                    }
                }

                // 如果仍然没有找到内容，尝试查找包含p标签的主要区域
                if (!content) {
                    // 寻找包含多个p标签的区域
                    const paragraphs = detail$('p');
                    if (paragraphs.length > 3) {
                        // 创建一个新的容器来存放段落内容
                        let paragraphsContent = '';
                        paragraphs.each((_, p) => {
                            const pContent = detail$(p).html();
                            if (pContent && !pContent.includes('style="display:none"')) {
                                paragraphsContent += `<p>${pContent}</p>`;
                            }
                        });
                        content = paragraphsContent;
                    }
                }

                // 清理内容，移除不必要的元素
                if (content) {
                    // 使用cheerio再次加载内容进行清理
                    const temp$ = load(`<div>${content}</div>`);

                    // 移除script标签
                    temp$('script').remove();
                    // 移除隐藏元素
                    temp$('[style*="display:none"], [style*="visibility:hidden"]').remove();
                    // 移除可能的广告和无关元素
                    temp$('.advertisement, .ad, .share, .copyright').remove();

                    content = temp$('div').html();
                }

                // 提取作者信息（如果有）
                let author = '国家市场监督管理总局计量司';
                const authorSelectors = ['.author', '.source', '.editor', '.byline'];

                for (const selector of authorSelectors) {
                    const foundAuthor = detail$(selector).text().trim();
                    if (foundAuthor) {
                        author = foundAuthor;
                        break;
                    }
                }

                return {
                    ...item,
                    description: content,
                    author,
                };
            } catch {
                // 如果获取详情失败，保留基本信息
                return item;
            }
        })
    );

    // 获取页面标题
    const title = $('title').text();
    const subtitle = type === 'legal' ? '法制计量' : '科学计量';

    return {
        item: items,
        title: `${title} - ${subtitle}`,
        link: currentUrl,
        description: `国家市场监督管理总局计量司${subtitle}相关信息`,
        language: 'zh',
        allowEmpty: true,
    };
}
