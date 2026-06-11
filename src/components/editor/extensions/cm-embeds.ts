import { ViewPlugin, Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/**
 * Widget for inline image embeds
 */
class ImageEmbedWidget extends WidgetType {
  constructor(readonly imagePath: string) {
    super();
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-embed-image";
    
    const img = document.createElement("img");
    img.src = this.imagePath;
    img.alt = this.imagePath;
    img.style.maxWidth = "100%";
    img.style.height = "auto";
    img.style.borderRadius = "4px";
    img.style.margin = "8px 0";
    
    container.appendChild(img);
    return container;
  }
}

/**
 * Widget for audio/video embeds
 */
class MediaEmbedWidget extends WidgetType {
  constructor(readonly mediaPath: string, readonly mediaType: 'audio' | 'video') {
    super();
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = `cm-embed-${this.mediaType}`;
    container.style.margin = "8px 0";
    
    if (this.mediaType === 'audio') {
      const audio = document.createElement("audio");
      audio.src = this.mediaPath;
      audio.controls = true;
      audio.style.width = "100%";
      container.appendChild(audio);
    } else {
      const video = document.createElement("video");
      video.src = this.mediaPath;
      video.controls = true;
      video.style.maxWidth = "100%";
      video.style.height = "auto";
      container.appendChild(video);
    }
    
    return container;
  }
}

/**
 * Parse ![[embed]] syntax and render inline
 */
export const embedsExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: any) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const embedRegex = /!\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;

      for (let { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let match;

        while ((match = embedRegex.exec(text)) !== null) {
          const embedPath = match[1];
          const start = from + match.index;
          const end = start + match[0].length;

          // Determine media type by extension
          const ext = embedPath.split('.').pop()?.toLowerCase() || '';
          
          let widget;
          if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
            widget = Decoration.widget({
              widget: new ImageEmbedWidget(embedPath),
              side: 1,
            });
          } else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
            widget = Decoration.widget({
              widget: new MediaEmbedWidget(embedPath, 'audio'),
              side: 1,
            });
          } else if (['mp4', 'webm', 'ogv'].includes(ext)) {
            widget = Decoration.widget({
              widget: new MediaEmbedWidget(embedPath, 'video'),
              side: 1,
            });
          }

          if (widget) {
            builder.add(end, end, widget);
          }
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
