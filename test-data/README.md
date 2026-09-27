# opencode-rag-plugin

This is a local RAG plugin for opencode. It indexes files, docs, and web content into Postgres using pgvector and searches them with cosine similarity.

## Features

- Token-based chunking (500 tokens, 75 overlap)
- Local embeddings via GGUF model
- pgvector-backed similarity search
- Sources: files, docs, and web
