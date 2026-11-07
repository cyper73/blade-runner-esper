// OCR locale via framework Vision (macOS). Nessuna rete, nessun modello esterno.
// Uso: ./ocr image.png   → stampa "testo<TAB>confidenza" per ogni riga trovata.
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("uso: ocr <immagine>\n".data(using: .utf8)!)
    exit(1)
}
let url = URL(fileURLWithPath: args[1])
guard let img = NSImage(contentsOf: url),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("immagine non leggibile\n".data(using: .utf8)!)
    exit(2)
}

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false      // non vogliamo che "corregga" SONY in altro
req.recognitionLanguages = ["en-US"]
req.minimumTextHeight = 0.0

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([req])
} catch {
    FileHandle.standardError.write("OCR fallito: \(error)\n".data(using: .utf8)!)
    exit(3)
}

for obs in (req.results ?? []) {
    if let c = obs.topCandidates(1).first {
        print("\(c.string)\t\(String(format: "%.3f", c.confidence))")
    }
}
