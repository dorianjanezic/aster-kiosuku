async function loadModules() {
  const { SentimentAnalyzer } = await import('../src/tools/sentimentAnalyzer.js');
  const { PublicClient } = await import('../src/http/publicClient.js');
  return { SentimentAnalyzer, PublicClient };
}

async function testSentimentAnalysis() {
  console.log('Testing sentiment analysis tool...\n');

  const { SentimentAnalyzer, PublicClient } = await loadModules();
  const client = new PublicClient();
  const analyzer = new SentimentAnalyzer(client);

  // Test with a popular crypto pair
  const pairs = [
    ['BTCUSDT', 'ETHUSDT'],
    ['SOLUSDT', 'AVAXUSDT'],
    ['DOGEUSDT', 'SHIBUSDT']
  ];

  for (const [long, short] of pairs) {
    console.log(`\n🔍 Analyzing sentiment for ${long}/${short}:`);

    try {
      const result = await analyzer.analyzePairSentiment(long, short, '24h');

      console.log(`   Sentiment Score: ${result.overallSentiment.toFixed(3)} (${result.overallSentiment > 0 ? '🐂 Bullish' : '🐻 Bearish'})`);
      console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`   Sources Analyzed: ${result.sourceCount}`);

      if (result.keySignals.length > 0) {
        console.log(`   Key Signals:`);
        result.keySignals.slice(0, 3).forEach(signal => {
          console.log(`     • ${signal}`);
        });
      }

      if (result.trendingTopics.length > 0) {
        console.log(`   Trending Topics: ${result.trendingTopics.slice(0, 3).join(', ')}`);
      }

    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
    }
  }

  console.log('\n✅ Sentiment analysis test completed!');
}

// Run the test
testSentimentAnalysis().catch(console.error);
