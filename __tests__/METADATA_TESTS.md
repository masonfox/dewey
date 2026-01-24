# Metadata Extraction Test Suite

## Overview

Comprehensive test suite for the metadata extraction feature, covering unit tests, integration tests, and end-to-end scenarios.

## Test Files

### 1. `__tests__/metadata.test.js` (29 tests)
**Purpose**: Unit tests for metadata extraction functions

**Coverage**:
- ✅ Metadata extraction from M4B files
- ✅ Metadata extraction from MP3 files  
- ✅ Field validation and structure
- ✅ Error handling and edge cases
- ✅ Directory metadata extraction
- ✅ File preference logic (M4B over MP3)
- ✅ Logging behavior
- ✅ Performance characteristics

**Key Test Scenarios**:
- Extract from real audiobooks (5 different files)
- Handle missing/partial metadata
- Process directories with mixed file types
- Graceful degradation when ffprobe unavailable
- File system error handling

### 2. `__tests__/metadata-integration.test.js` (13 tests)
**Purpose**: Integration tests for metadata + Claude normalization flow

**Coverage**:
- ✅ Metadata passed to Claude for enhanced normalization
- ✅ Year/genre providing disambiguation context
- ✅ Author name variation handling
- ✅ Backward compatibility (works without metadata)
- ✅ Partial metadata handling
- ✅ End-to-end pipeline validation
- ✅ Quality improvements from metadata enrichment

**Key Test Scenarios**:
- Full pipeline: extract → normalize → verify
- Metadata consistency across multiple extractions
- Error handling in integrated flow
- Comparison: with vs without metadata
- Complex filename handling with metadata

## Test Statistics

```
Total Tests: 42
Total Assertions: 151
Execution Time: ~18 seconds
Success Rate: 100%
```

## Test Data

Tests use real audiobook files:
- `01 Angels and Demons.m4b` (Dan Brown, 2004)
- `R.F. Kuang - Katabasis.m4b` (R. F. Kuang, 2025)
- `Matt Dinniman - Dungeon Crawler Carl.m4b` (Matt Dinniman, 2021)
- `Lodestar.mp3` (Shannon Messenger)
- `Neverseen.mp3` (Shannon Messenger)

## Running Tests

### Run all metadata tests
```bash
NODE_OPTIONS='--experimental-vm-modules' bun test __tests__/metadata*.test.js
```

### Run unit tests only
```bash
NODE_OPTIONS='--experimental-vm-modules' bun test __tests__/metadata.test.js
```

### Run integration tests only
```bash
NODE_OPTIONS='--experimental-vm-modules' bun test __tests__/metadata-integration.test.js
```

### Run with timeout for Claude API calls
```bash
NODE_OPTIONS='--experimental-vm-modules' bun test __tests__/metadata-integration.test.js --timeout 60000
```

## Test Coverage By Feature

### Core Functionality
- ✅ Extract title, author, year, genre from audio files
- ✅ Prefer M4B files over MP3 in directories
- ✅ Handle missing/partial metadata gracefully
- ✅ Clean and validate metadata values
- ✅ Detect and skip placeholder values ("Unknown Artist")

### Claude Integration
- ✅ Pass metadata to Claude prompts
- ✅ Enhanced normalization with metadata context
- ✅ Backward compatibility without metadata
- ✅ Year-based disambiguation
- ✅ Genre-based context enhancement

### Error Handling
- ✅ Non-existent files
- ✅ Non-audio files
- ✅ Empty directories
- ✅ Permission errors
- ✅ ffprobe not installed
- ✅ Malformed file metadata

### Performance
- ✅ Metadata extraction < 2 seconds per file
- ✅ Consistent results across multiple calls
- ✅ Efficient directory scanning

### Real-World Scenarios
- ✅ Professional audiobooks (Audible format)
- ✅ Multi-file audiobooks
- ✅ Mixed audio and non-audio files
- ✅ Complex directory structures
- ✅ Files with special characters in names

## Test Design Principles

1. **Use Real Data**: Tests use actual audiobook files to ensure real-world accuracy
2. **Comprehensive Coverage**: Unit tests + integration tests + end-to-end scenarios
3. **Graceful Degradation**: Verify features work with and without metadata
4. **Error Resilience**: Test error conditions don't crash the system
5. **Performance Validation**: Ensure metadata extraction is fast enough
6. **Backward Compatibility**: Verify existing functionality still works

## Mock Objects

### Logger Mock
```javascript
const mockLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {}
};
```

Used for basic tests where log verification isn't needed.

### Logger Mock with Capture
```javascript
function createMockLogger() {
  const calls = { info: [], warn: [], debug: [], error: [] };
  return {
    log: {
      info: (...args) => calls.info.push(args),
      warn: (...args) => calls.warn.push(args),
      debug: (...args) => calls.debug.push(args),
      error: (...args) => calls.error.push(args)
    },
    calls
  };
}
```

Used for tests that verify logging behavior.

## Future Test Enhancements

### Potential Additions
- [ ] Mock ffprobe for testing without real files
- [ ] Test with corrupted/malformed audio files
- [ ] Benchmark tests for large batches
- [ ] Test with different ffprobe versions
- [ ] Test metadata extraction from other formats (FLAC, AAC)
- [ ] Stress tests with hundreds of files
- [ ] Memory leak detection tests
- [ ] Concurrent extraction tests

### Integration Points to Test
- [ ] Full migration flow with metadata
- [ ] Job queue with metadata extraction
- [ ] Database/logging with metadata fields
- [ ] UI display of extracted metadata
- [ ] Metadata-based search/filtering

## Debugging Failed Tests

### Common Issues

**Issue**: Tests fail with "Cannot find module"
**Solution**: Ensure you're running from project root with correct NODE_OPTIONS

**Issue**: Tests timeout
**Solution**: Increase timeout for integration tests that call Claude API
```bash
bun test --timeout 60000
```

**Issue**: Tests fail with "file not found"
**Solution**: Ensure test audiobook files exist in `/home/mason/Downloads/`

**Issue**: Claude API tests fail
**Solution**: Check ANTHROPIC_API_KEY is set and valid, or skip integration tests

### Debug Mode
```bash
# Run with verbose output
LOG_LEVEL=debug NODE_OPTIONS='--experimental-vm-modules' bun test __tests__/metadata.test.js
```

## CI/CD Considerations

For CI/CD pipelines:
1. **Mock ffprobe output** - Don't rely on real audiobook files in CI
2. **Skip Claude integration tests** - API calls are slow and may rate limit
3. **Use test fixtures** - Small test audio files for consistent results
4. **Set timeouts** - Claude tests need longer timeouts (60s)

## Test Maintenance

- **Update test data** when audiobook metadata format changes
- **Add tests** for new metadata fields (if expanded beyond 4 fields)
- **Monitor performance** - Update expectations if extraction gets slower
- **Review mocks** - Ensure mocks match actual ffprobe output format

---

**Last Updated**: 2026-01-24
**Test Framework**: Bun Test
**Test Files**: 2
**Total Tests**: 42
**Test Lines**: ~450 lines
