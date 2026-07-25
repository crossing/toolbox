package cli

import (
	"github.com/crossing/toolbox/tools/freeagent/internal/freeagent"

	"github.com/spf13/cobra"
)

var (
	billURL  string
	billFile string
)

// billsAttachCmd represents the attach command
var billsAttachCmd = &cobra.Command{
	Use:   "attach",
	Short: "Attach a file to a bill",
	Long:  "Attach a local file (receipt or invoice) to an existing bill in FreeAgent.",
	RunE: func(cmd *cobra.Command, args []string) error {
		attachment, err := freeagent.CreateAttachmentFromFile(billFile)
		if err != nil {
			return err
		}

		bill := freeagent.Bill{
			Attachment: attachment,
		}

		updatedBill, err := apiClient.UpdateBill(billURL, bill)
		if err != nil {
			return err
		}

		return formatOutput(updatedBill)
	},
}

func init() {
	billsCmd.AddCommand(billsAttachCmd)

	billsAttachCmd.Flags().StringVar(&billURL, "url", "", "Bill URI")
	billsAttachCmd.Flags().StringVar(&billFile, "file", "", "Path to the file to attach")

	_ = billsAttachCmd.MarkFlagRequired("url")
	_ = billsAttachCmd.MarkFlagRequired("file")
}
