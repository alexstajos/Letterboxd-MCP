const LetterboxdClient = require('./letterboxd');
const cheerio = require('cheerio');

async function debug() {
    const client = new LetterboxdClient();
    await client.init();
    const html = await client.getPageSource('https://letterboxd.com/film/inception/');
    const $ = cheerio.load(html);
    
    console.log('Title H1:', $('h1').text().trim());
    console.log('Headline-1:', $('.headline-1').text().trim());
    console.log('Section Header:', $('#featured-film-header h1').text().trim());
    
    // Look for all script tags that might contain metadata
    $('script[type="application/ld+json"]').each((i, el) => {
        console.log('JSON-LD:', $(el).html());
    });

    await client.close();
}

debug();
