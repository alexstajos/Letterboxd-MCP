const LetterboxdClient = require('./letterboxd');

async function test() {
    const client = new LetterboxdClient();
    try {
        console.log('Initializing client...');
        await client.init();

        console.log('\n--- Testing search (films: "Inception") ---');
        const searchResults = await client.search('Inception');
        console.log('Results:', JSON.stringify(searchResults.slice(0, 2), null, 2));

        if (searchResults.length > 0) {
            const slug = searchResults[0].slug;
            console.log(`\n--- Testing get_film (slug: "${slug}") ---`);
            const filmDetails = await client.getFilm(slug);
            console.log('Film details:', JSON.stringify(filmDetails, null, 2));
        }

        console.log('\n--- Testing get_member (username: "dvdpulse") ---');
        const member = await client.getMember('dvdpulse');
        console.log('Member profile:', JSON.stringify(member, null, 2));

        console.log('\n--- Testing get_member_watchlist (username: "dvdpulse") ---');
        const watchlist = await client.getMemberWatchlist('dvdpulse');
        console.log('Watchlist items:', watchlist.length);

        console.log('\n--- Testing get_member_diary (username: "dvdpulse") ---');
        const diary = await client.getMemberDiary('dvdpulse');
        console.log('Diary entries:', diary.length);

        console.log('\n--- Testing get_member_ratings (username: "official") ---');
        const ratings = await client.getMemberRatings('official');
        console.log('Ratings count:', ratings.length);

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        await client.close();
        console.log('\nTests completed.');
    }
}

test();
